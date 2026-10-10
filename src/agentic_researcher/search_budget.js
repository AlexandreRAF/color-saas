'use strict';

// One instance per vehicle, shared by every search stage/provider. Admission is
// synchronous, so parallel jobs and retries cannot each spend the last slot.
class SearchBudget {
  constructor(limit = 20, log = () => {}, verificationReserve = Math.min(4, Math.floor(limit / 3))) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new Error('maxBrowserUses must be an integer between 1 and 20');
    }
    if (!Number.isInteger(verificationReserve) || verificationReserve < 0 || verificationReserve > limit) {
      throw new Error('verificationReserve must be an integer between 0 and maxBrowserUses');
    }
    this.limit = limit;
    this.verificationReserve = verificationReserve;
    this.used = 0;
    this.httpAttempts = 0;
    this.byPhase = { research: 0, verification: 0 };
    this.skipped = 0;
    this.reported = new Set();
    this.log = log;
  }

  remaining(phase = 'research') {
    const available = this.limit - this.used;
    return phase === 'verification' ? available : Math.min(available,
      Math.max(0, this.limit - this.verificationReserve - this.byPhase.research));
  }

  reserve(phase = 'research') {
    phase = phase === 'verification' ? phase : 'research';
    if (!this.remaining(phase)) {
      this.skipped++;
      if (!this.reported.has(phase)) {
        this.reported.add(phase);
        this.log('search_budget_exhausted', { phase, ...this.summary() });
      }
      throw Object.assign(new Error('Browser search budget exhausted; use collected evidence'),
        { code: 'BROWSER_BUDGET_EXHAUSTED' });
    }
    this.used++;
    this.byPhase[phase]++;
    let sent = false;
    return {
      wrap: request => async (...args) => {
        args[1]?.signal?.throwIfAborted();
        if (sent) this.reserve(phase); // Every HTTP retry spends another slot.
        sent = true;
        this.httpAttempts++;
        return request(...args);
      },
    };
  }

  summary() {
    return { limit: this.limit, slotsUsed: this.used, httpAttempts: this.httpAttempts,
      remaining: this.limit - this.used, skipped: this.skipped,
      verificationReserve: this.verificationReserve, byPhase: { ...this.byPhase } };
  }
}

module.exports = { SearchBudget };
