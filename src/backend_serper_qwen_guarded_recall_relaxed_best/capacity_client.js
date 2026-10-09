'use strict';

const net = require('node:net');
const { capacityContext } = require('./capacity_context');
const { awaitWithSignal } = require('./model_stream');

const RATE_HEADERS = ['retry-after', 'retry-after-ms', ...['tokens', 'requests', 'project-tokens']
  .flatMap(resource => ['limit', 'remaining', 'reset'].map(kind => `x-ratelimit-${kind}-${resource}`))];

class CapacityClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.pending = new Map();
    this.sequence = 0;
  }

  connect() {
    if (this.connection) return this.connection;
    this.connection = new Promise((resolve, reject) => {
      const socket = this.socket = net.createConnection(this.socketPath);
      let buffer = '';
      const timeout = setTimeout(() => socket.destroy(new Error('Capacity coordinator connection timed out')), 3000);
      socket.once('connect', () => { clearTimeout(timeout); socket.unref(); resolve(socket); });
      socket.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 65536) return socket.destroy(new Error('Capacity protocol message too large'));
        let boundary;
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
          try { this.receive(JSON.parse(line)); }
          catch (error) { socket.destroy(error); }
        }
      });
      socket.on('error', error => { clearTimeout(timeout); reject(error); });
      socket.on('close', () => {
        clearTimeout(timeout);
        this.connection = null;
        for (const entry of this.pending.values()) {
          entry.cleanup();
          entry.reject(Object.assign(new Error('Capacity coordinator disconnected'), { code: 'CAPACITY_UNAVAILABLE' }));
        }
        this.pending.clear();
      });
    });
    return this.connection;
  }

  send(message) {
    if (!this.socket || this.socket.destroyed) throw new Error('Capacity coordinator unavailable');
    this.socket.write(JSON.stringify(message) + '\n');
  }

  receive(message) {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    if (message.type === 'wait') {
      if (entry.cancelled) return;
      try { entry.endWait ||= entry.timing?.beginWait() || (() => {}); } catch { return; }
      try { entry.onWait?.({ event: 'capacity_wait_start', kind: entry.kind }); } catch { /* Observer only. */ }
      return;
    }
    if (message.type === 'granted') {
      entry.cleanup();
      if (entry.cancelled) { this.send({ type: 'cancel', id: message.id }); return; }
      let settled = false;
      const finish = (type, details = {}) => {
        if (settled) return;
        settled = true;
        try { this.send({ id: message.id, type, ...details }); }
        catch { this.pending.delete(message.id); }
      };
      entry.resolve({ ...message.choice,
        cancel: () => finish('cancel'),
        complete: (response, body) => finish('complete', {
          response: response && { status: response.status, ok: response.ok,
            headers: Object.fromEntries(RATE_HEADERS.map(name => [name, response.headers?.get?.(name)]).filter(([, value]) => value != null)) },
          usage: body?.usage && { input_tokens: body.usage.input_tokens || 0, output_tokens: body.usage.output_tokens || 0 },
          capacityHold: body?.capacityHold === true,
          firstContentStall: body?.firstContentStall === true,
        }),
      });
      return;
    }
    if (message.type === 'unavailable') {
      entry.cleanup();
      this.pending.delete(message.id);
      if (!this.pending.size) this.socket.unref();
      entry.resolve(null);
      return;
    }
    entry.cleanup();
    this.pending.delete(message.id);
    if (!this.pending.size) this.socket.unref();
    if (message.type === 'error') entry.reject(Object.assign(new Error(message.error), { code: 'CAPACITY_UNAVAILABLE' }));
  }

  async acquire({ choices, tokens, immediate = false, kind = 'main', scope, signal, timing, onWait,
    runId = capacityContext.getStore()?.runId || String(process.pid) }) {
    signal?.throwIfAborted();
    const socket = signal ? await awaitWithSignal(() => this.connect(), signal) : await this.connect();
    signal?.throwIfAborted();
    socket.ref();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timing, onWait, kind };
      const started = Date.now();
      const abort = () => {
        entry.cancelled = true;
        try { this.send({ id, type: 'cancel' }); } catch { /* Disconnection rejects queued work. */ }
        entry.cleanup();
        reject(signal?.reason || new Error('Capacity queue wait exceeded 120000 ms'));
      };
      const timeout = setTimeout(abort, 120000);
      entry.cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (entry.endWait) {
          entry.endWait(); entry.endWait = null;
          try { onWait?.({ event: 'capacity_wait_end', kind, waitMs: Date.now() - started }); } catch { /* Observer only. */ }
        }
      };
      this.pending.set(id, entry);
      signal?.addEventListener('abort', abort, { once: true });
      this.send({ type: 'acquire', id, choices, tokens, immediate, kind, scope, runId });
    });
  }

  close() { this.socket?.destroy(); }
}

module.exports = { CapacityClient, RATE_HEADERS };
