// Capacity waits overlap across concurrent jobs. Count their union once and
// optionally pause processing deadlines while a job waits for admission.
// Soft deadlines guide optional work without cancelling required stages.
class RunTiming {
  constructor({ maxCapacityWaitMs = 120000, signal, now = () => performance.now(), pauseForCapacity = true,
    softDeadlines = false, targetTimeMs, hardLimitMs } = {}) {
    if (!Number.isFinite(maxCapacityWaitMs) || maxCapacityWaitMs < 0) {
      throw new Error('maxCapacityWaitMs must be a nonnegative number');
    }

    this.now = now;
    this.pauseForCapacity = pauseForCapacity;
    this.softDeadlines = softDeadlines;
    this.targetTimeMs = targetTimeMs;
    this.hardLimitMs = hardLimitMs;
    this.started = now();
    this.maxCapacityWaitMs = maxCapacityWaitMs;
    this.waiters = 0;
    this.waited = 0;
    this.modelRequestMs = 0;
    this.deadlines = new Set();
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.parentSignal = signal;
    this.onAbort = () => this.abort(signal.reason);

    if (signal?.aborted) this.onAbort();
    else signal?.addEventListener('abort', this.onAbort, { once: true });

    if (hardLimitMs !== undefined) {
      if (!Number.isFinite(hardLimitMs) || hardLimitMs < 1) throw new Error('Invalid hard time limit');
      this.hardTimer = setTimeout(() => this.abort(Object.assign(
        new DOMException('Maximum processing time exceeded', 'TimeoutError'),
        { deadlineExceeded: true, code: 'RUN_HARD_DEADLINE' })), hardLimitMs);
    }
  }

  abort(reason) {
    this.controller.abort(reason);
    for (const deadline of this.deadlines) deadline.controller.abort(reason);
  }

  capacityWaitMs() {
    return this.waited + (this.waiters ? this.now() - this.waitStarted : 0);
  }

  processingMs() {
    return this.now() - this.started - this.capacityWaitMs();
  }

  deadlineElapsedMs() {
    return this.pauseForCapacity ? this.processingMs() : this.now() - this.started;
  }

  beginWait() {
    this.signal.throwIfAborted();

    if (this.waiters++ === 0) {
      this.waitStarted = this.now();
      if (this.pauseForCapacity) for (const deadline of this.deadlines) clearTimeout(deadline.timer);
      this.waitTimer = setTimeout(() => this.abort(new Error(
        `Capacity wait exceeded ${this.maxCapacityWaitMs} ms`)), Math.max(0, this.maxCapacityWaitMs - this.waited));
    }

    let ended = false;

    return () => {
      if (ended) return;

      ended = true;

      if (--this.waiters === 0) {
        this.waited += this.now() - this.waitStarted;
        clearTimeout(this.waitTimer);
        for (const deadline of this.deadlines) this.arm(deadline);
      }
    };
  }

  arm(deadline) {
    clearTimeout(deadline.timer);

    if (this.signal.aborted) return deadline.controller.abort(this.signal.reason);
    if (this.softDeadlines && !deadline.fixed) return;
    if ((this.waiters && this.pauseForCapacity) || deadline.controller.signal.aborted) return;

    deadline.timer = setTimeout(() => deadline.controller.abort(
      Object.assign(new DOMException('Processing deadline exceeded', 'TimeoutError'), { deadlineExceeded: true })),
    Math.max(0, Math.ceil(deadline.at - this.deadlineElapsedMs())));
  }

  deadline(durationMs) {
    const deadline = { controller: new AbortController(), at: this.deadlineElapsedMs() + durationMs };

    this.deadlines.add(deadline);
    this.arm(deadline);

    return deadline.controller.signal;
  }

  // Absolute stage cutoffs cannot be extended by a retry or a late fetch.
  deadlineAt(at) {
    const deadline = { controller: new AbortController(), at, fixed: true };
    this.deadlines.add(deadline);
    this.arm(deadline);
    return deadline.controller.signal;
  }

  remainingMs(signal) {
    if (signal?.aborted) return 0;
    if (this.softDeadlines && ![...this.deadlines].some(entry => entry.fixed && entry.controller.signal === signal)) return Infinity;

    return this.remainingTargetMs(signal);
  }

  // Scheduling hint only; an expired target does not cancel its signal.
  remainingTargetMs(signal) {
    if (signal?.aborted) return 0;
    const deadline = [...this.deadlines].find(entry => entry.controller.signal === signal);
    return deadline ? Math.max(0, deadline.at - this.deadlineElapsedMs()) : Infinity;
  }

  extendDeadline(signal, at) {
    const deadline = [...this.deadlines].find(entry => entry.controller.signal === signal);

    if (!deadline || deadline.fixed || signal.aborted || !Number.isFinite(at) || at <= deadline.at) return false;

    deadline.at = at;
    this.arm(deadline);

    return true;
  }

  summary() {
    const totalMs = Math.round(this.now() - this.started);
    const capacityWaitMs = Math.min(totalMs, Math.round(this.capacityWaitMs()));
    return { totalMs, processingMs: totalMs - capacityWaitMs, capacityWaitMs,
      modelRequestMs: Math.round(this.modelRequestMs),
      ...(Number.isFinite(this.targetTimeMs) && {
        targetTimeMs: this.targetTimeMs,
        deadlineMode: this.softDeadlines ? 'soft' : 'hard',
        overTargetMs: Math.max(0, totalMs - this.targetTimeMs),
      }),
      ...(Number.isFinite(this.hardLimitMs) && { maxTimeMs: this.hardLimitMs }) };
  }

  close() {
    clearTimeout(this.waitTimer);
    clearTimeout(this.hardTimer);

    for (const deadline of this.deadlines) clearTimeout(deadline.timer);

    this.deadlines.clear();
    this.parentSignal?.removeEventListener('abort', this.onAbort);
  }
}

module.exports = { RunTiming };
