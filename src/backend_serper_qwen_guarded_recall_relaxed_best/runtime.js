// Shared bounded concurrency and HTTP retries. A failed item never cancels its peers.
function createLimiter(concurrency) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency');

  let active = 0;
  const queue = [];

  return async (operation) => {
    if (active < concurrency) active++;
    else await new Promise((resolve) => queue.push(resolve));

    try { return await operation(); }
    finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

const { modelScheduler, estimateTokens, retryAfterMs } = require('./model_scheduler');

const { setTimeout: delay } = require('node:timers/promises');

async function requestJson(url, init, {
  request = fetch, timeoutMs = 10000, retries = 1, signal, onRetry = () => {}, onAttempt = () => {},
  scheduler = modelScheduler, schedule = {}, timing, onWait,
} = {}) {
  const scheduled = url === 'https://api.openai.com/v1/responses';
  const network = schedule.kind === 'search' || url === 'https://google.serper.dev/search';
  const payload = scheduled ? JSON.parse(init.body) : null;
  const choices = schedule.choices || (network ? [{ model: 'network:search' }] : null) || (payload && [{ model: payload.model, serviceTier: payload.service_tier }]);
  const parent = signal && timing ? AbortSignal.any([signal, timing.signal]) : signal || timing?.signal;

  for (let attempt = 0; ; attempt++) {
    parent?.throwIfAborted();

    // Admission precedes the HTTP timeout: capacity waiting must not kill queued work.
    const ticket = scheduled || network ? await scheduler.acquire({ choices, tokens: network ? 1 : estimateTokens(payload),
      kind: schedule.kind, signal: parent, timing, onWait }) : null;
    let error, response, body, requestStarted;
    let retryDelay = 200 * 2 ** attempt;

    try {
      parent?.throwIfAborted();

      const timeout = AbortSignal.timeout(timeoutMs);

      onAttempt();
      requestStarted = performance.now();
      response = await request(url, { ...init,
        ...(ticket && scheduled && { body: JSON.stringify({ ...payload, model: ticket.model, service_tier: ticket.serviceTier }) }),
        signal: parent ? AbortSignal.any([parent, timeout]) : timeout });

      try { body = await response.json(); }
      catch (parseError) {
        // HTML/empty error responses must retain their HTTP status and retry policy.
        if (response.ok) throw parseError;
      }

      if (response.ok) {
        if (ticket && scheduled) Object.defineProperties(body, {
          _requestModel: { value: ticket.model }, _requestServiceTier: { value: ticket.serviceTier },
        });
        return body;
      }

      error = new Error(`HTTP ${response.status}: ${body?.error?.message || body?.error?.detail || body?.message
        || (typeof body?.error === 'string' && body.error) || 'request failed'}`);
      error.status = response.status;
      error.providerCode = body?.error?.code;
      error.retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status)
        && !/quota|USAGE_LIMIT_EXCEEDED|billing|hard.limit|not enough credits|insufficient[_ ]credits|credits? (?:exhausted|depleted)|payment required/i.test(`${body?.error?.code || ''} ${error.message}`);

      const wait = retryAfterMs(response.headers, body);

      error.retryAfterMs = wait;

      if (ticket && scheduled && [429, 503].includes(response.status)) retryDelay = 0; // Shared cooldown on next admission.
      else if (wait > 2000) error.retryable = false;
      else if (wait > 0) retryDelay = wait;
    } catch (caught) {
      error = caught;
      if (parent?.aborted) throw parent.reason;
      error.retryable = error instanceof SyntaxError || ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name)
        || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/.test(error.cause?.code || error.code || '');
    } finally {
      if (timing && scheduled && requestStarted !== undefined) timing.modelRequestMs += performance.now() - requestStarted;
      if (requestStarted === undefined) ticket?.cancel();
      else ticket?.complete(response, body);
    }

    if (!error.retryable || attempt >= retries) {
      error.attempts = attempt + 1;
      throw error;
    }

    onRetry({ attempt: attempt + 1, waitMs: retryDelay, error: error.message });

    if (retryDelay) await delay(retryDelay, undefined, { signal: parent });
  }
}

module.exports = { createLimiter, requestJson };
