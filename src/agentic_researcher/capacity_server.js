'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

if (require.main === module) require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
const { ModelScheduler } = require('./model_scheduler');

// One local Unix-socket coordinator owns account capacity across all workers.
// It sees only admission metadata, usage and rate-limit headers, never API keys,
// prompts, vehicle evidence or result bodies. Use one coordinator per account.
async function startCapacityServer(socketPath, { scheduler = new ModelScheduler(), leaseMs = 60000 } = {}) {
  if (!path.isAbsolute(socketPath)) throw new Error('CAPACITY_SOCKET must be an absolute Unix socket path');
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('Capacity lease must be positive');
  const sockets = new Set();
  const cleanupConnections = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    const jobs = new Map();
    let buffer = '';
    const send = message => { if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n'); };
    const settle = (id, cancel, response, usage, capacityHold, firstContentStall) => {
      const job = jobs.get(id);
      if (!job) return;
      jobs.delete(id);
      clearTimeout(job.lease);
      job.controller.abort(new Error('Capacity request released'));
      if (cancel) job.ticket?.cancel();
      else job.ticket?.complete(response && { ...response, headers: new Headers(response.headers) },
        { ...(usage && { usage }), ...(capacityHold === true && { capacityHold: true }),
          ...(firstContentStall === true && { firstContentStall: true }) });
      send({ id, type: 'done' });
      if (!jobs.size && socket.destroyed) cleanupConnections.delete(cleanup);
    };
    const receive = async message => {
      const { id, type } = message;
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid capacity request ID');
      if (type === 'cancel' || type === 'complete') {
        settle(id, type === 'cancel', message.response, message.usage,
          message.capacityHold, message.firstContentStall);
        return;
      }
      if (type !== 'acquire' || jobs.has(id) || jobs.size >= 2000) throw new Error('Invalid or excessive capacity request');
      if (!Array.isArray(message.choices) || !message.choices.length
        || message.choices.some(choice => !Object.hasOwn(scheduler.limits, choice.model)
          || (choice.tokens !== undefined && (!Number.isFinite(choice.tokens) || choice.tokens <= 0)))) {
        throw new Error('Unknown capacity pool');
      }
      const job = { controller: new AbortController() };
      jobs.set(id, job);
      try {
        const ticket = await scheduler.acquire({ choices: message.choices, tokens: message.tokens,
          immediate: message.immediate === true,
          scope: typeof message.scope === 'string' ? message.scope.slice(0, 253) : undefined,
          kind: message.kind, runId: String(message.runId || socket.remoteAddress).slice(0, 128),
          signal: job.controller.signal, onWait: ({ event }) => {
            if (event === 'capacity_wait_start') send({ type: 'wait', id });
          } });
        if (!jobs.has(id) || socket.destroyed) { ticket?.cancel(); return; }
        if (!ticket) { jobs.delete(id); send({ type: 'unavailable', id }); return; }
        job.ticket = ticket;
        // A dead worker may already have sent a provider request. Keep its token
        // charge and concurrency lease until the maximum request lifetime ends.
        job.lease = setTimeout(() => settle(id, false), leaseMs);
        send({ type: 'granted', id, choice: { model: ticket.model, serviceTier: ticket.serviceTier } });
      } catch (error) {
        if (jobs.has(id)) { jobs.delete(id); send({ type: 'error', id, error: error.message }); }
      }
    };
    const cleanup = () => { for (const id of jobs.keys()) settle(id, false); };
    cleanupConnections.add(cleanup);
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 65536) return socket.destroy();
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        try { receive(JSON.parse(line)).catch(error => { send({ type: 'error', error: error.message }); socket.destroy(); }); }
        catch { socket.destroy(); }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      for (const [id, job] of jobs) if (!job.ticket) settle(id, true);
      if (!jobs.size) cleanupConnections.delete(cleanup);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.removeListener('error', reject); fs.chmodSync(socketPath, 0o600); resolve(); });
  });
  return { server, scheduler, async close() {
    for (const cleanup of cleanupConnections) cleanup();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}

module.exports = { startCapacityServer };

if (require.main === module) {
  const socketPath = process.env.CAPACITY_SOCKET || '/tmp/paint-capacity.sock';
  startCapacityServer(socketPath).then(instance => {
    console.log(`Capacity coordinator listening on ${socketPath}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => instance.close().then(() => process.exit(0)));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
