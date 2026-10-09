'use strict';

function admissionError(code, message, retryable) {
  return Object.assign(new Error(message), { code,
    details: { code, retryable, ...(retryable && { retryAfterMs: 1000 }) } });
}

// Production admission is account-wide through the existing coordinator. Model
// queues cannot protect a vehicle whose discovery deadline is already running
// behind several other vehicles. Reject overload before any paid work starts.
async function admitRun(options, scheduler, timing, log, env = process.env) {
  if (!(options.production ?? env.NODE_ENV === 'production')) return null;
  if (!env.CAPACITY_SOCKET && !options.scheduler) {
    throw admissionError('PRODUCTION_CAPACITY_REQUIRED',
      'Production requires CAPACITY_SOCKET or an explicitly shared scheduler', false);
  }
  const timeoutMs = options.admissionTimeoutMs ?? 100;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1000) {
    throw admissionError('INVALID_ADMISSION_TIMEOUT', 'admissionTimeoutMs must be between 1 and 1000', false);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(admissionError('RUN_CAPACITY_BUSY',
    'Research capacity is full; retry after the active request finishes', true)), timeoutMs);
  const signal = AbortSignal.any([controller.signal, timing.signal]);
  try {
    const ticket = await scheduler.acquire({ choices: [{ model: 'network:run' }], tokens: 1,
      kind: 'runAdmission', signal, timing, onWait: ({ event, ...details }) => log(event, details) });
    // A late coordinator grant may race with cancellation; do not leak its slot.
    if (signal.aborted) { ticket.cancel(); signal.throwIfAborted(); }
    log('run_admitted', { production: true });
    return ticket;
  } finally { clearTimeout(timer); }
}

module.exports = { admitRun };
