const { setTimeout: delay } = require('node:timers/promises');

const { modelScheduler, retryAfterMs } = require('./model_scheduler');

// Search retries share an engine cooldown and the caller's remaining budget.
// They must not occupy the entire remaining research window on a blind retry.
async function searchRequest(url, { request = fetch, engine, state, signal,
  remainingMs = () => Infinity, onEvent = () => {}, timeoutMs = 8000, minAttemptMs = 1500 }) {
  const cooldowns = state.cooldowns ||= new Map();

  for (let attempt = 1; attempt <= 2; attempt++) {
    signal.throwIfAborted();

    const cooldown = Math.max(0, (cooldowns.get(engine) || 0) - Date.now());

    if (cooldown + minAttemptMs > remainingMs()) {
      throw Object.assign(new Error('Insufficient search time after engine cooldown'),
        { name: 'TimeoutError', attempts: attempt - 1, retryAfterMs: cooldown });
    }

    if (cooldown) {
      onEvent('search_engine_cooldown', { engine, waitMs: cooldown });
      await delay(cooldown, undefined, { signal });
    }

    const budget = Math.min(timeoutMs, remainingMs());
    const started = performance.now();
    let response, body, error, ticket;

    onEvent('search_engine_attempt', { engine, attempt, timeoutMs: Math.round(budget) });

    try {
      ticket = await modelScheduler.acquire({ choices: [{ model: 'network:search' }], tokens: 1, kind: 'search', signal });
      response = await request(url, { method: 'GET', headers: { Accept: 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.ceil(budget)))]) });

      try { body = await response.json(); } catch (cause) { if (response.ok) throw cause; }

      if (response.ok) {
        onEvent('search_engine_http', { engine, attempt, status: response.status || 200,
          durationMs: Math.round(performance.now() - started), cache: response.headers?.get?.('x-cache') || undefined });
        return body;
      }

      error = Object.assign(new Error(`HTTP ${response.status}: ${body?.error?.message || body?.error || 'search failed'}`),
        { status: response.status });
    } catch (cause) { error = cause; }
    finally { ticket?.complete(response); }

    error.attempts = attempt;

    const wait = Math.max(response?.status === 429 ? 1000 : 200, retryAfterMs(response?.headers, body) || 0);

    if ([429, 503].includes(response?.status)) cooldowns.set(engine, Math.max(cooldowns.get(engine) || 0, Date.now() + wait));

    error.retryAfterMs = wait;
    onEvent('search_engine_attempt_failed', { engine, attempt, status: response?.status,
      durationMs: Math.round(performance.now() - started), error: error.message, retryAfterMs: wait });
    signal.throwIfAborted();

    const retryable = [408, 425, 429, 500, 502, 503, 504].includes(error.status)
      || ['TimeoutError', 'TypeError', 'SyntaxError'].includes(error.name);

    if (attempt === 2 || !retryable || wait + minAttemptMs > remainingMs()) throw error;

    onEvent('search_engine_retry', { engine, attempt: attempt + 1, waitMs: wait });
    await delay(wait, undefined, { signal });
  }
}

// Subscribers share only pending work. One caller cancelling must not cancel
// another caller's search; cancel the HTTP request once nobody needs it.
function sharedSearch(state, key, operation, { signal, remainingMs = () => Infinity, onSource }) {
  const pending = state.pending ||= new Map();
  let job = pending.get(key);
  const fresh = !job;

  if (fresh) {
    job = { controller: new AbortController(), subscribers: new Set(), sources: [] };
    pending.set(key, job);
  }

  return new Promise((resolve, reject) => {
    const subscriber = { resolve, reject, remainingMs, onSource, cleanup: () => signal?.removeEventListener('abort', abort) };
    const abort = () => {
      job.subscribers.delete(subscriber);
      subscriber.cleanup();
      reject(signal.reason);

      if (!job.subscribers.size) {
        if (pending.get(key) === job) pending.delete(key);
        job.controller.abort(signal.reason);
      }
    };

    job.subscribers.add(subscriber);

    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });

    if (!signal?.aborted) for (const row of job.sources) onSource?.(row);
    if (!fresh) return;

    const settle = (method, value) => {
      if (pending.get(key) === job) pending.delete(key);
      for (const subscriber of job.subscribers) { subscriber.cleanup(); subscriber[method](value); }
      job.subscribers.clear();
    };

    Promise.resolve().then(() => operation({ signal: job.controller.signal,
      remainingMs: () => Math.max(0, ...[...job.subscribers].map(subscriber => subscriber.remainingMs())),
      onSource: row => {
        job.sources.push(row);
        for (const subscriber of job.subscribers) subscriber.onSource?.(row);
      },
    })).then(value => settle('resolve', value), error => settle('reject', error));
  });
}

module.exports = { searchRequest, sharedSearch };
