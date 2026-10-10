'use strict';

// One instance per vehicle. Coalesce settled matching work before occupying
// provider slots; catalogue evidence and each original index remain independent.
class MatcherBatcher {
  constructor(execute, { size = 8, maxChars = 65000, concurrency = 3 } = {}) {
    if (![size, maxChars, concurrency].every(value => Number.isInteger(value) && value > 0)) {
      throw new Error('Invalid matcher batching limits');
    }
    Object.assign(this, { execute, size, maxChars, concurrency, pending: [], active: 0, sequence: 0 });
  }

  async add(payload, options) {
    const pending = Promise.allSettled(payload.colors.map(color => new Promise((resolve, reject) => {
      this.pending.push({ color, vehicle: payload.vehicle, options, resolve, reject });
    })));
    this.schedule();
    const settled = await pending;
    const matches = settled.filter(row => row.status === 'fulfilled').map(row => row.value);
    const incompleteIndices = settled.flatMap((row, index) => row.status === 'rejected' ? [payload.colors[index].index] : []);
    if (!matches.length && settled.length) throw settled[0].reason;
    // execute reports usage once through the owning run's callback. Returning
    // it to every contributing batch would count the same paid call repeatedly.
    return { result: { matches }, incompleteIndices, usage: {} };
  }

  schedule() {
    if (!this.timer && this.pending.length && this.active < this.concurrency) {
      this.timer = setTimeout(() => this.flush(), 40);
    }
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    while (this.pending.length && this.active < this.concurrency) {
      const first = this.pending[0];
      const vehicleKey = JSON.stringify(first.vehicle);
      const batch = [];
      let chars = 6000; // Instructions/schema allowance, without trimming evidence.
      while (this.pending.length && batch.length < this.size) {
        const next = this.pending[0];
        const length = JSON.stringify(next.color).length;
        if (batch.length && (chars + length > this.maxChars || next.options.signal !== first.options.signal
          || JSON.stringify(next.vehicle) !== vehicleKey)) break;
        batch.push(this.pending.shift());
        chars += length;
      }
      this.active++;
      this.executeBatch(batch).finally(() => {
        this.active--;
        this.flush();
      });
    }
  }

  async executeBatch(batch) {
    try {
      const first = batch[0];
      first.options.signal?.throwIfAborted();
      const sequence = ++this.sequence;
      const result = await this.execute({ vehicle: first.vehicle,
        colors: batch.map((entry, index) => ({ ...entry.color, index })) }, { ...first.options,
        onDebug: (name, data) => first.options.onDebug?.(`transport-${sequence}-${name}`, data),
      });
      const decisions = new Map(result.result.matches.map(row => [row.index, row]));
      for (const [index, entry] of batch.entries()) {
        const decision = decisions.get(index);
        if (!decision) entry.reject(new Error('Code matcher omitted an input index'));
        else entry.resolve({ ...decision, index: entry.color.index });
      }
    } catch (error) {
      for (const entry of batch) entry.reject(error);
    }
  }
}

module.exports = { MatcherBatcher };
