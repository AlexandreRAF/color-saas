const test = require('node:test');
const assert = require('node:assert/strict');
const { browse } = require('../browse');
const { searchFailure } = require('../search_errors');
const { finalOutput } = require('../final_output');

const httpError = (status, message, headers) => ({ ok: false, status, headers,
  json: async () => ({ message }) });

test('search errors have stable classifications and safe recovery guidance', () => {
  const cases = [
    [new Error('HTTP 400: Not enough credits'), 'SEARCH_CREDITS_EXHAUSTED', false],
    [new Error('HTTP 402: Payment required'), 'SEARCH_CREDITS_EXHAUSTED', false],
    [new Error('HTTP 429: insufficient_quota'), 'SEARCH_CREDITS_EXHAUSTED', false],
    [new Error('SERPER_API_KEY is required'), 'SEARCH_AUTH_FAILED', false],
    [new Error('HTTP 401: Denied'), 'SEARCH_AUTH_FAILED', false],
    [new Error('HTTP 403: Denied'), 'SEARCH_AUTH_FAILED', false],
    [new Error('HTTP 429: Too many requests'), 'SEARCH_RATE_LIMITED', true],
    [new DOMException('Timed out', 'TimeoutError'), 'SEARCH_TIMEOUT', true],
    [new TypeError('fetch failed'), 'SEARCH_UNAVAILABLE', true],
    [new Error('HTTP 503: unavailable'), 'SEARCH_UNAVAILABLE', true],
    [new SyntaxError('invalid JSON'), 'SEARCH_INVALID_RESPONSE', true],
    [new Error('HTTP 400: secret provider payload'), 'SEARCH_FAILED', false],
  ];
  for (const [cause, code, retryable] of cases) {
    const error = searchFailure(cause);
    assert.equal(error.details.code, code);
    assert.equal(error.details.retryable, retryable);
    assert.equal(error.details.provider, 'serper');
    assert.ok(error.details.action);
    assert.doesNotMatch(error.message, /secret provider payload/);
  }
});

test('credit exhaustion skips queued searches without retrying or erasing completed sources', async () => {
  let calls = 0;
  const results = await browse(['good', 'empty balance', 'queued', 'also queued'], {
    apiKey: 'test', concurrency: 1, request: async () => ++calls === 1
      ? { ok: true, json: async () => ({ organic: [{ link: 'https://source.test/chart' }] }) }
      : httpError(400, 'Not enough credits'),
  });
  assert.equal(calls, 2);
  assert.equal(results[0].results.length, 1);
  assert.equal(results[1].errorDetails.attempts, 1);
  assert.ok(results.slice(2).every(result => result.skipped));
  assert.ok(results.slice(1).every(result => result.errorDetails.code === 'SEARCH_CREDITS_EXHAUSTED'));
  // No process-wide billing cache: topping up takes effect on the next run.
  const next = await browse(['retry after top-up'], { apiKey: 'test', request: async () => ({
    ok: true, json: async () => ({ organic: [] }),
  }) });
  assert.equal(next[0].error, undefined);
});

test('non-JSON authentication failures keep their status and are not retried', async () => {
  let calls = 0;
  const [result] = await browse(['query'], { apiKey: 'test', request: async () => {
    calls++;
    return { ok: false, status: 403, json: async () => { throw new SyntaxError('HTML error page'); } };
  } });
  assert.equal(calls, 1);
  assert.equal(result.errorDetails.code, 'SEARCH_AUTH_FAILED');
  assert.equal(result.errorDetails.httpStatus, 403);
});

test('temporary failures retry once and return a long cooldown without waiting for it', async () => {
  let calls = 0;
  const [result] = await browse(['query'], { apiKey: 'test', request: async () => {
    calls++;
    return httpError(503, 'unavailable', new Headers({ 'retry-after': '0.001' }));
  } });
  assert.equal(calls, 2);
  assert.equal(result.errorDetails.attempts, 2);
  assert.equal(result.errorDetails.retryable, true);
  calls = 0;
  const [limited] = await browse(['query'], { apiKey: 'test', request: async () => {
    calls++;
    return httpError(429, 'rate limited', new Headers({ 'retry-after': '30' }));
  } });
  assert.equal(calls, 1);
  assert.equal(limited.errorDetails.retryAfterMs, 30000);
  assert.equal(limited.errorDetails.code, 'SEARCH_RATE_LIMITED');
});

test('string billing errors do not retry even with a 429 status', async () => {
  let calls = 0;
  const [result] = await browse(['query'], { apiKey: 'test', request: async () => {
    calls++;
    return { ok: false, status: 429, json: async () => ({ error: 'Not enough credits' }) };
  } });
  assert.equal(calls, 1);
  assert.equal(result.errorDetails.code, 'SEARCH_CREDITS_EXHAUSTED');
});

test('cancellation is propagated and prevents queued requests', async () => {
  const controller = new AbortController();
  const reason = new Error('Caller cancelled');
  let calls = 0;
  await assert.rejects(browse(['first', 'queued'], { apiKey: 'test', concurrency: 1,
    signal: controller.signal, request: async () => {
      calls++;
      controller.abort(reason);
      throw reason;
    },
  }), error => error === reason);
  assert.equal(calls, 1);
});

test('compact and expanded errors preserve structured details and group identical warnings', () => {
  const error = searchFailure(new Error('HTTP 400: Not enough credits'));
  for (const format of ['compact', 'expanded']) {
    const result = finalOutput({ error: error.message, errorDetails: error.details,
      warnings: ['query one', 'query two'].map(message => ({ stage: 'search', message, details: error.details })),
    }, { format });
    assert.deepEqual(result.errorDetails, error.details);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].count, 2);
    assert.equal(result.warnings[0].code, 'SEARCH_CREDITS_EXHAUSTED');
    assert.equal(result.warnings[0].action, error.details.action);
  }
});
