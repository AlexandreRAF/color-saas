export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function demand(condition, status, code, message) {
  if (!condition) throw new AppError(status, code, message);
}

// Only allowlisted diagnostic fields reach logs; never serialize errors, requests or inputs.
export function log(event, fields = {}) {
  const allowed = ['requestId', 'jobId', 'attemptId', 'code', 'durationMs', 'count', 'state'];
  console.log(JSON.stringify({ time: new Date().toISOString(), event,
    ...Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.includes(key))) }));
}
