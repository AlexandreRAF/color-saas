const { createLimiter } = require('./runtime');

// Reuse a match only when the approved name, sources, evidence and finish
// decision are unchanged, including across the bounded omission-repair wave.
class CodeMatchPipeline {
  constructor(match, concurrency = 6) {
    this.match = match;
    this.limit = createLimiter(concurrency);
    this.entries = new Map();
    this.jobs = [];
    this.incomplete = new Set();
    this.retried = new Set();
  }

  start(colors) {
    const fresh = colors.filter(color => !this.entries.has(JSON.stringify(color)));

    if (!fresh.length) return;

    for (const color of fresh) this.incomplete.add(JSON.stringify(color));

    const job = this.limit(() => this.match(fresh)).then(matched => {
      const failedIndices = new Set(matched.incompleteIndices || []);
      const failedNames = new Set(matched.incompleteNames || []);
      for (const [index, color] of fresh.entries()) {
        const key = JSON.stringify(color);
        if (failedIndices.has(index) || !matched.incompleteIndices && failedNames.has(color.name)) this.incomplete.add(key);
        else this.incomplete.delete(key);
      }
      const byInput = new Map();
      for (const [position, color] of matched.entries()) {
        const index = color._matchInputIndex ?? (matched.length === fresh.length ? position : undefined);
        if (Number.isInteger(index) && fresh[index]) byInput.set(index, color);
      }
      // Injected legacy matchers may omit indices and remove confirmed finish
      // mismatches. A unique name remains safe; duplicate names stay separate.
      if (byInput.size < matched.length) {
        const counts = new Map();
        for (const color of fresh) counts.set(color.name, (counts.get(color.name) || 0) + 1);
        for (const color of matched) {
          if (Number.isInteger(color._matchInputIndex) || counts.get(color.name) !== 1) continue;
          const index = fresh.findIndex(item => item.name === color.name);
          if (index >= 0) byInput.set(index, color);
        }
      }
      return byInput;
    });

    this.jobs.push(job);

    for (const [index, color] of fresh.entries()) {
      // Null means the matcher confidently excluded this exact finish/evidence.
      // A changed final candidate gets a new match, including prior exclusions.
      const result = job.then(byInput => byInput.get(index) || null);

      result.catch(() => {}); // Observed again by finish/drain; no detached rejection.
      this.entries.set(JSON.stringify(color), result);
    }
  }

  async finish(colors) {
    this.start(colors);

    await Promise.all(colors.map(color => this.entries.get(JSON.stringify(color))));
    const retry = colors.filter(color => this.incomplete.has(JSON.stringify(color)) && !this.retried.has(JSON.stringify(color)));
    for (const color of retry) {
      const key = JSON.stringify(color);
      this.entries.delete(key);
      this.retried.add(key);
    }
    this.start(retry);
    const matched = await Promise.all(colors.map(color => this.entries.get(JSON.stringify(color))));

    await this.drain();

    return matched.filter(Boolean);
  }

  drain() { return Promise.allSettled(this.jobs); }

  coverage(colors) {
    const incompleteNames = colors.filter(color => {
      const key = JSON.stringify(color);
      return !this.entries.has(key) || this.incomplete.has(key);
    }).map(color => color.name);
    return { total: colors.length, completed: colors.length - incompleteNames.length,
      incomplete: incompleteNames.length, ...(incompleteNames.length && { incompleteNames }) };
  }
}

module.exports = { CodeMatchPipeline };
