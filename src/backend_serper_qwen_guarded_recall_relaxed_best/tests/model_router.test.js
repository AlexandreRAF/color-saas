const test = require('node:test');
const assert = require('node:assert/strict');

const { requestModel, routeTimeouts, attemptBudget, firstContentBudget } = require('../model_router');
const { ModelScheduler } = require('../model_scheduler');
const { RunTiming } = require('../run_timing');

const routeIds = ['gpt-6-luna', 'openrouter:openai/gpt-6-luna', 'gpt-5.6-luna', 'openrouter:openai/gpt-5.6-luna'];
const payload = { model: 'ignored-model', instructions: 'Preserve the entire evidence.', input: 'Complete source text.',
  reasoning: { effort: 'low' }, max_output_tokens: 8192,
  text: { format: { type: 'json_schema', name: 'check', strict: true,
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } } };
const init = { headers: { Authorization: 'Bearer direct-key' }, body: JSON.stringify(payload) };
const response = (extra = {}) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({
  status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
  usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, ...extra }) });
const failure = status => ({ ok: false, status, headers: new Headers(), json: async () => ({ error: { message: 'Unavailable' } }) });
const call = options => requestModel('https://api.openai.com/v1/responses', init, {
  scheduler: new ModelScheduler(), routing: { openrouterApiKey: 'router-key', capacityWaitMs: 10 }, ...options,
});

test('GPT budget admission receives the original envelope and adds reasoning allowance once', async () => {
  let admitted, sent;
  await call({ schedule: { kind: 'main' }, routing: { openrouterApiKey: '', budget: {
    reserve: async (_route, request) => { admitted = request; return { complete() {} }; },
  } }, request: async (_url, options) => { sent = JSON.parse(options.body); return response(); } });
  assert.equal(admitted.max_output_tokens, payload.max_output_tokens);
  assert.equal(sent.max_output_tokens, payload.max_output_tokens + 1024);
});

test('GPT structured review first-content allowance stays inside the original attempt budget', () => {
  const limits = routeTimeouts('databaseMatcher', 8000, {}, {});
  assert.equal(firstContentBudget({}, 'databaseMatcher', {}, limits, {}), 6000);
  assert.equal(firstContentBudget({}, 'candidateReview', {}, limits, {}), 6000);
  const largeReview = routeTimeouts('candidateReview', 16000, {}, {}, { ...payload, input: 'x'.repeat(50000) });
  assert.equal(firstContentBudget({}, 'candidateReview', {}, largeReview, {}), 10000);
  assert.equal(firstContentBudget({ chat: true }, 'candidateReview', {}, limits, {}), 4000);
  assert.equal(firstContentBudget({}, 'pageAnalysis', {}, limits, {}), 4000);
  assert.equal(firstContentBudget({}, 'databaseMatcher', { firstContentMs: 4000 }, limits, {}), 4000);
  assert.equal(firstContentBudget({}, 'databaseMatcher', {}, limits, { MODEL_FIRST_CONTENT_MS: '4000' }), 4000);
  const initialAttempt = attemptBudget(limits.requestMs, 4000, true);
  assert.equal(Math.min(initialAttempt, firstContentBudget({}, 'databaseMatcher', {}, limits, {})), 2400);
});

test('transport normalization accepts only unambiguous metadata and enum wrappers', () => {
  const { normalizeBatchMember } = require('../model_router');
  const schema = { anyOf: [{ type: 'string', enum: ['unrelated_hue', 'review'] },
    { type: 'object', properties: { decision: { enum: ['include'] }, detail: { type: ['object', 'null'] } } }] };
  assert.equal(normalizeBatchMember({ unrelated_hue: 'unrelated_hue' }, schema), 'unrelated_hue');
  assert.equal(normalizeBatchMember({ review: 'review' }, schema), 'review');
  for (const value of [{ unrelated_hue: 'review' }, { unrelated_hue: 'unrelated_hue', reason: 'x' },
    { invented: 'invented' }, { action: 'include' }, { decision: 'include', detail: { question: 'Check finish' } }]) {
    assert.deepEqual(normalizeBatchMember(value, schema), value);
  }
  assert.deepEqual(normalizeBatchMember({ decision: 'include' }, schema), { decision: 'include', detail: null });
});

test('route attempt budgets leave time for fallback inside an expiring stage', () => {
  assert.equal(attemptBudget(12000, 4000, true), 2400);
  assert.equal(attemptBudget(12000, 4000, false), 4000);
  assert.equal(attemptBudget(12000, Infinity, true), 12000);
  assert.equal(attemptBudget(12000, 20000, true), 12000);
  assert.equal(attemptBudget(12000, 1, true), 1);
  assert.equal(attemptBudget(12000, 2500, true, 1500), 2500);
  assert.equal(attemptBudget(12000, 4000, true, 1500), 2400);
  assert.equal(attemptBudget(12000, 400, true, 0), 240);
});

test('a late stalled primary falls back before its fixed stage deadline', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  const signal = timing.deadlineAt(400);
  const sent = [];
  try {
    const result = await call({ timing, signal, routing: { openrouterApiKey: 'router-key', minimumAttemptWindowMs: 0 },
      request: async (_url, options) => {
      sent.push(JSON.parse(options.body).model);
      if (sent.length === 1) return new Promise(() => {});
      return response();
    } });
    assert.equal(result._requestProvider, 'openrouter');
    assert.equal(signal.aborted, false);
    assert.deepEqual(sent, ['gpt-6-luna', 'openai/gpt-6-luna']);
  } finally { timing.close(); }
});

test('nearly expired stages send no paid request and acquire no capacity', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  const scheduler = new ModelScheduler();
  try {
    await assert.rejects(call({ timing, scheduler, signal: timing.deadlineAt(1200),
      request: async () => assert.fail('No useful response can finish in the remaining window'),
    }), { code: 'MODEL_DEADLINE_INSUFFICIENT' });
    assert.equal(scheduler.queue.length, 0);
    assert.ok([...scheduler.models.values()].every(state => state.active === 0));
  } finally { timing.close(); }
});

test('a deadline-shortened timeout cannot put a healthy route into cooldown', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  const scheduler = new ModelScheduler();
  const sent = [];
  const request = async (_url, options) => {
    const model = JSON.parse(options.body).model;
    sent.push(model);
    if (sent.length === 1) return new Promise(() => {});
    return model.startsWith('qwen/') ? { ...response(), json: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }) } : response();
  };
  const options = { scheduler, request, schedule: { kind: 'verification' },
    routing: { openrouterApiKey: 'router-key', minimumAttemptWindowMs: 0, qwenTimeoutMs: 1000 } };
  try {
    await call({ ...options, timing, signal: timing.deadlineAt(400) });
    await call(options);
    assert.deepEqual(sent, ['qwen/qwen3.5-flash-02-23', 'gpt-6-luna', 'qwen/qwen3.5-flash-02-23']);
  } finally { timing.close(); }
});

test('single-candidate batch wrappers are restored only when the child matches exactly', async () => {
  const child = { type: 'string', enum: ['unrelated_hue'] };
  const makePayload = count => ({ ...payload, text: { format: { ...payload.text.format,
    schema: { type: 'object', properties: Object.fromEntries(Array.from({ length: count }, (_, i) => [`R${i + 1}`, child])),
      required: Array.from({ length: count }, (_, i) => `R${i + 1}`), additionalProperties: false } } } });
  for (const [count, verdict, passes] of [[1, 'unrelated_hue', true], [2, 'unrelated_hue', false], [1, 'invented', false]]) {
    const job = requestModel('https://api.openai.com/v1/responses', { ...init, body: JSON.stringify(makePayload(count)) }, {
      scheduler: new ModelScheduler(), routing: { openrouterApiKey: '' }, allowPartialBatch: true,
      request: async () => response({ output: [{ type: 'message', content: [
        { type: 'output_text', text: JSON.stringify(verdict) },
      ] }] }),
    });
    if (passes) assert.deepEqual(JSON.parse((await job).output[0].content[0].text), { R1: verdict });
    else await assert.rejects(job, /required JSON schema/);
  }
});

test('route defaults move stalled extraction, reviews and capacity waits to fallback sooner', () => {
  assert.deepEqual(routeTimeouts('pageAnalysis', 16000, {}, {}), {
    capacityMs: 200, qwenCapacityMs: 500, requestMs: 12000, qwenMs: 6000, geminiMs: 8000, firstContentMs: 4000, idleMs: 2500,
  });
  assert.equal(routeTimeouts('candidateReview', 16000, {}, {}).requestMs, 14000);
  assert.equal(routeTimeouts('candidateReview', 16000, {}, {}).qwenMs, 8000);
  assert.equal(routeTimeouts('verification', 16000, {}, {}).qwenCapacityMs, 3500);
  assert.equal(routeTimeouts('candidateReview', 1000, {}, {}).qwenMs, 1000);
  assert.equal(routeTimeouts('main', 16000, { timeoutMs: 12000 }, {}).requestMs, 12000);
  assert.equal(routeTimeouts('pageAnalysis', 16000, {}, { QWEN_PAGE_TIMEOUT_MS: '3000' }).qwenMs, 3000);
  assert.equal(routeTimeouts('pageAnalysis', 16000, { qwenTimeoutMs: 2000 }, { QWEN_PAGE_TIMEOUT_MS: '3000' }).qwenMs, 2000);
  assert.throws(() => routeTimeouts('main', 16000, { timeoutMs: 0 }, {}), /Invalid model route timeouts/);
});

for (const phase of ['request', 'response_body']) {
  test(`fallback bounds a stalled ${phase} even when the client ignores cancellation`, async () => {
    const scheduler = new ModelScheduler();
    const events = [], budgets = [], signals = [];
    let calls = 0;
    const result = await call({ scheduler, onWait: event => events.push(event),
      routing: { openrouterApiKey: 'router-key', timeoutMs: 20, budget: {
        reserve: async () => ({ cancel: () => assert.fail('Sent calls must retain their reservation'),
          complete: usage => budgets.push(usage) }),
      } },
      request: async (_url, options) => {
        signals.push(options.signal);
        if (++calls > 1) return response();
        return phase === 'request' ? new Promise(() => {})
          : { ...response(), json: () => new Promise(() => {}) };
      },
    });

    assert.equal(result._requestProvider, 'openrouter');
    assert.equal(calls, 2);
    assert.ok(signals[0].aborted);
    assert.equal(scheduler.state('gpt-6-luna').active, 0);
    assert.equal(budgets.length, 2);
    assert.equal(budgets[0].usage, undefined); // Unknown billed usage is never refunded as unsent.
    assert.ok(budgets[1].usage);
    const fallback = events.find(event => event.code === 'MODEL_ROUTE_TIMEOUT');
    assert.equal(fallback.phase, phase);
    assert.equal(fallback.timeoutMs, 20);
    assert.ok(fallback.durationMs < 1000);
  });
}

test('failed HTTP status falls back without waiting for a stalled error body', async () => {
  const scheduler = new ModelScheduler();
  const calls = [], events = [];
  const request = async (url, options) => {
    calls.push(JSON.parse(options.body).model);
    return url.includes('openrouter.ai') ? response()
      : { ...failure(402), json: () => new Promise(() => {}) };
  };

  await call({ scheduler, request, onWait: event => events.push(event) });
  await call({ scheduler, request });
  assert.deepEqual(calls, ['gpt-6-luna', 'openai/gpt-6-luna', 'openai/gpt-6-luna']);
  const fallback = events.find(event => event.event === 'model_route_fallback');
  assert.match(fallback.reason, /HTTP 402/);
  assert.ok(fallback.durationMs < 1000);
});

test('non-JSON authentication errors retain status and disable the failing credential', async () => {
  const scheduler = new ModelScheduler();
  const calls = [];
  const request = async (url, options) => {
    calls.push(JSON.parse(options.body).model);
    return url.includes('openrouter.ai') ? response()
      : { ...failure(401), json: async () => { throw new SyntaxError('HTML error page'); } };
  };

  await call({ scheduler, request });
  await call({ scheduler, request });
  assert.deepEqual(calls, ['gpt-6-luna', 'openai/gpt-6-luna', 'openai/gpt-6-luna']);
});

test('caller cancellation interrupts stalled body consumption without starting fallback', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(call({ signal: controller.signal, request: async () => {
    calls++;
    return { ...response(), json: () => {
      controller.abort(new Error('Cancelled during body read'));
      return new Promise(() => {});
    } };
  } }), /Cancelled during body read/);
  assert.equal(calls, 1);
});

test('timeout cooldown skips repeated slow reviews but preserves page extraction on that model', async () => {
  const scheduler = new ModelScheduler();
  const calls = [];
  const routing = { openrouterApiKey: 'router-key', qwenTimeoutMs: 20 };
  const request = async (_url, options) => {
    const model = JSON.parse(options.body).model;
    calls.push(model);
    if (calls.length === 1) return new Promise(() => {});
    return model.startsWith('qwen/') ? { ...response(), json: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }) } : response();
  };

  await call({ scheduler, routing, request, schedule: { kind: 'candidateReview' } });
  await call({ scheduler, routing, request, schedule: { kind: 'candidateReview' } });
  await call({ scheduler, routing, request, schedule: { kind: 'pageAnalysis' } });
  assert.deepEqual(calls, ['qwen/qwen3.5-flash-02-23', 'gpt-6-luna', 'gpt-6-luna', 'qwen/qwen3.5-flash-02-23']);
});

test('a route disabled during admission is skipped and unsent reservations are refunded', async () => {
  const scheduler = new ModelScheduler();
  const acquire = scheduler.acquire.bind(scheduler);
  let nested = false, cancelled = 0;
  const calls = [];
  const request = async (url, options) => {
    calls.push(JSON.parse(options.body).model);
    return url.includes('openrouter.ai') ? response() : failure(402);
  };
  scheduler.acquire = async options => {
    if (!nested) {
      nested = true;
      await call({ scheduler, request });
    }
    return acquire(options);
  };

  await call({ scheduler, request, routing: { openrouterApiKey: 'router-key', budget: {
    reserve: async () => ({ cancel: () => cancelled++, complete: () => {} }),
  } } });
  assert.deepEqual(calls, ['gpt-6-luna', 'openai/gpt-6-luna', 'openai/gpt-6-luna']);
  assert.equal(cancelled, 1);
  assert.ok([...scheduler.models.values()].every(state => state.active === 0));
});

test('partial review batches retain valid children only with explicit caller validation', async () => {
  const child = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const body = { ...payload, text: { format: { ...payload.text.format,
    schema: { type: 'object', properties: { R1: child, R2: child }, required: ['R1', 'R2'], additionalProperties: false } } } };
  for (const allowPartialBatch of [true, false]) {
    let calls = 0;
    const run = requestModel('https://api.openai.com/v1/responses', { ...init, body: JSON.stringify(body) }, {
      scheduler: new ModelScheduler(), routing: { openrouterApiKey: 'router-key' }, allowPartialBatch,
      request: async () => {
        calls++;
        return response({ output: [{ type: 'message', content: [{ type: 'output_text',
          text: JSON.stringify({ R1: { ok: true }, R2: { ok: 'invalid' } }) }] }] });
      },
    });
    if (allowPartialBatch) {
      assert.equal((await run).status, 'completed');
      assert.equal(calls, 1);
    } else {
      await assert.rejects(run, /required JSON schema/);
      assert.equal(calls, 4);
    }
  }
});

for (let succeedAt = 0; succeedAt < 4; succeedAt++) {
  test(`strict fallback order reaches route ${succeedAt + 1}, preserving evidence and separating keys`, async () => {
    const calls = [], ledger = [];
    const result = await call({ onUsage: e => ledger.push(e), request: async (url, options) => {
      const body = JSON.parse(options.body), router = url.includes('openrouter.ai');
      calls.push(router ? `openrouter:${body.model}` : body.model);
      assert.equal(options.headers.Authorization, router ? 'Bearer router-key' : 'Bearer direct-key');
      for (const field of ['instructions', 'input', 'reasoning', 'text']) assert.deepEqual(body[field], payload[field]);
      assert.equal(body.max_output_tokens, payload.max_output_tokens + 1024);
      assert.equal(body.store, false);
      assert.equal(body.service_tier, router ? undefined : body.model === 'gpt-6-luna' ? 'fast' : 'default');
      return calls.length <= succeedAt ? failure(503) : response();
    } });
    assert.deepEqual(calls, routeIds.slice(0, succeedAt + 1));
    assert.equal(result._requestModel, calls.at(-1).replace(/^openrouter:/, ''));
    assert.equal(ledger.length, succeedAt + 1);
    assert.equal(ledger.at(-1).provider, succeedAt % 2 ? 'openrouter' : 'openai');
  });
}

test('budget admission can skip an expensive route and use an affordable fallback without charging the skipped route', async () => {
  const checked = [], sent = [];
  let settled = 0;
  const result = await call({ routing: { openrouterApiKey: 'router-key', budget: {
    reserve: async route => {
      checked.push(route.id);
      if (route.provider === 'openai') throw Object.assign(new Error('AI cost target reached'), { code: 'AI_BUDGET_LIMIT' });
      return { complete: details => { assert.ok(details.usage); settled++; } };
    },
  } }, request: async url => { sent.push(url); return response(); } });
  assert.deepEqual(checked, routeIds.slice(0, 2));
  assert.equal(sent.length, 1);
  assert.equal(result._requestProvider, 'openrouter');
  assert.equal(settled, 1);
});

test('budget rejection cannot consume model request or token capacity', async () => {
  const scheduler = new ModelScheduler({ now: () => 0 });
  const before = { ...scheduler.state('gpt-6-luna') };
  await assert.rejects(call({ scheduler, routing: { openrouterApiKey: '', budget: {
    reserve: async () => { throw Object.assign(new Error('AI cost target reached'), { code: 'AI_BUDGET_LIMIT' }); },
  } }, request: () => assert.fail('Must not send') }), /AI cost target reached/);
  assert.equal(scheduler.state('gpt-6-luna').tokens, before.tokens);
  assert.equal(scheduler.state('gpt-6-luna').requests, before.requests);
  assert.equal(scheduler.state('gpt-6-luna').active, 0);
});

test('bad schema, incomplete output and invalid JSON fail over and retain all reported usage', async () => {
  let calls = 0;
  const ledger = [];
  const result = await call({ onUsage: e => ledger.push(e), request: async () => {
    const cases = [response({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }] }),
      response({ status: 'incomplete' }),
      response({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'not JSON' }] }] }), response()];
    return cases[calls++];
  } });
  assert.equal(result._requestModel, 'openai/gpt-5.6-luna');
  assert.equal(ledger.length, 4);
  assert.equal(ledger.reduce((sum, e) => sum + e.usage.total_tokens, 0), 48);
});

test('capacity saturation falls through to OpenRouter without waiting for the direct pool', async () => {
  const scheduler = new ModelScheduler({ limits: { 'gpt-6-luna': { concurrency: 1 } } });
  const occupied = await scheduler.acquire({ choices: [{ model: 'gpt-6-luna' }], tokens: 1 });
  const timer = setInterval(() => {}, 20);
  try {
    const result = await call({ scheduler, request: async () => response() });
    assert.equal(result._requestProvider, 'openrouter');
    assert.equal(result._requestModel, 'openai/gpt-6-luna');
    assert.equal(scheduler.queue.length, 0);
  } finally { occupied.complete({ ok: true }); clearInterval(timer); }
});

test('a verification request falls back after its short Qwen capacity wait', async () => {
  const qwen = 'openrouter:qwen/qwen3.5-flash-02-23';
  const direct = 'gpt-6-luna';
  const scheduler = new ModelScheduler({ limits: { [qwen]: { concurrency: 1 },
    [direct]: { concurrency: 1 } } });
  const occupied = await Promise.all([qwen, direct].map(model =>
    scheduler.acquire({ choices: [{ model }], tokens: 1 })));
  const acquisitions = [];
  const acquire = scheduler.acquire.bind(scheduler);
  scheduler.acquire = options => { acquisitions.push(options.choices.map(choice => choice.model)); return acquire(options); };
  try {
    const result = await call({ scheduler, schedule: { kind: 'verification' },
      routing: { openrouterApiKey: 'router-key', qwenCapacityWaitMs: 10, capacityWaitMs: 10 },
      request: async () => response(),
    });
    assert.equal(result._requestModel, 'openai/gpt-6-luna');
    assert.equal(acquisitions.length, 3);
    assert.deepEqual(acquisitions[0], [qwen]);
    assert.deepEqual(acquisitions[1], [qwen]);
    assert.ok(acquisitions[2].includes('openrouter:openai/gpt-6-luna'));
  } finally { occupied.forEach(ticket => ticket.complete({ ok: true })); }
});

test('verification waits for a short Qwen capacity burst before using a fallback', async () => {
  const model = 'openrouter:qwen/qwen3.5-flash-02-23';
  const scheduler = new ModelScheduler({ limits: { [model]: { concurrency: 1 } } });
  const occupied = await scheduler.acquire({ choices: [{ model }], tokens: 1 });
  const timer = setTimeout(() => occupied.complete({ ok: true }), 250);
  const sent = [];
  try {
    const result = await call({ scheduler, schedule: { kind: 'verification' },
      routing: { openrouterApiKey: 'router-key', qwenCapacityWaitMs: 1000 },
      request: async (url, options) => {
        sent.push(JSON.parse(options.body).model);
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({
          status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        }) };
      },
    });
    // The shared mock below uses a Responses envelope, so the Qwen chat
    // attempt intentionally fails parsing and then exercises GPT fallback.
    assert.equal(result._requestModel, 'gpt-6-luna');
    assert.deepEqual(sent, ['qwen/qwen3.5-flash-02-23', 'gpt-6-luna']);
  } finally { clearTimeout(timer); occupied.complete({ ok: true }); }
});

test('candidate review briefly waits for a cheap Qwen slot, then falls back on expiry', async () => {
  const model = 'openrouter:qwen/qwen3.5-flash-02-23';
  const scheduler = new ModelScheduler({ limits: { [model]: { concurrency: 1 } } });
  const occupied = await scheduler.acquire({ choices: [{ model }], tokens: 1 });
  const sent = [];
  const request = async (_url, options) => {
    const name = JSON.parse(options.body).model;
    sent.push(name);
    return name.startsWith('qwen/') ? { ok: true, status: 200, headers: new Headers(), json: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }) } : response();
  };
  const release = setTimeout(() => occupied.complete({ ok: true }), 25);
  try {
    const result = await call({ scheduler, request, schedule: { kind: 'candidateReview' },
      routing: { openrouterApiKey: 'router-key', qwenCapacityWaitMs: 120 } });
    assert.equal(result._requestModel, 'qwen/qwen3.5-flash-02-23');
    assert.deepEqual(sent, ['qwen/qwen3.5-flash-02-23']);
  } finally { clearTimeout(release); occupied.complete({ ok: true }); }

  const blocked = await scheduler.acquire({ choices: [{ model }], tokens: 1 });
  try {
    const result = await call({ scheduler, request, schedule: { kind: 'candidateReview' },
      routing: { openrouterApiKey: 'router-key', qwenCapacityWaitMs: 10 } });
    assert.equal(result._requestModel, 'gpt-6-luna');
    assert.equal(sent.at(-1), 'gpt-6-luna');
  } finally { blocked.complete({ ok: true }); }
});

test('candidate review uses GPT when the configured Qwen token ceiling cannot fit the batch', async () => {
  const scheduler = new ModelScheduler({ limits: {
    'openrouter:qwen/qwen3.5-flash-02-23': { tokensPerMinute: 100, requestsPerMinute: 100,
      concurrency: 2, reserveTokens: 0 },
  } });
  const result = await call({ scheduler, schedule: { kind: 'candidateReview' },
    request: async (_url, options) => {
      assert.equal(JSON.parse(options.body).model, 'gpt-6-luna');
      return response();
    } });
  assert.equal(result._requestModel, 'gpt-6-luna');
});

test('all busy routes wait for available capacity without dropping the request or spending stage time', async () => {
  const scheduler = new ModelScheduler({ limits: Object.fromEntries(routeIds.map(id => [id, { concurrency: 1 }])) });
  const tickets = await Promise.all(routeIds.map(model => scheduler.acquire({ choices: [{ model }], tokens: 1 })));
  const timing = new RunTiming();
  const timer = setTimeout(() => tickets[1].complete({ ok: true }), 100);
  try {
    const result = await call({ scheduler, timing, request: async () => response() });
    assert.equal(result._requestModel, 'openai/gpt-6-luna');
    assert.ok(timing.summary().capacityWaitMs >= 70);
    assert.equal(scheduler.queue.length, 0);
  } finally { clearTimeout(timer); tickets.forEach(ticket => ticket.complete({ ok: true })); timing.close(); }
});

test('caller cancellation stops an in-flight request without starting fallback', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(call({ signal: controller.signal, request: async () => {
    calls++; controller.abort(new Error('Cancelled by caller')); throw controller.signal.reason;
  } }), /Cancelled by caller/);
  assert.equal(calls, 1);
});

test('a stalled HTTP request releases its slot and switches routes', async () => {
  const scheduler = new ModelScheduler();
  let calls = 0;
  const timer = setInterval(() => {}, 20);
  try {
    const result = await call({ scheduler, routing: { openrouterApiKey: 'router-key', timeoutMs: 10 },
      request: async (_url, options) => ++calls === 1
        ? new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
        : response() });
    assert.equal(result._requestProvider, 'openrouter');
    assert.equal(scheduler.state('gpt-6-luna').active, 0);
  } finally { clearInterval(timer); }
});

test('provider billing cooldown is shared across calls but does not disable the other provider', async () => {
  const scheduler = new ModelScheduler();
  const calls = [];
  const request = async (url, options) => {
    calls.push(JSON.parse(options.body).model);
    return url.includes('openrouter.ai') ? response() : failure(402);
  };
  await call({ scheduler, request });
  await call({ scheduler, request });
  assert.deepEqual(calls, ['gpt-6-luna', 'openai/gpt-6-luna', 'openai/gpt-6-luna']);
});

test('a genuine OpenRouter credit failure uses funded fallbacks for the full vehicle window', async () => {
  const scheduler = new ModelScheduler();
  const calls = [];
  const request = async (url, options) => {
    const model = JSON.parse(options.body).model;
    calls.push(model);
    return url.includes('openrouter.ai')
      ? { ...failure(402), json: async () => ({ error: { message: 'Insufficient credits' } }) }
      : response();
  };

  await call({ scheduler, request, schedule: { kind: 'verification' },
    routing: { openrouterApiKey: 'router-key' } });
  await call({ scheduler, request, schedule: { kind: 'verification' },
    routing: { openrouterApiKey: 'router-key' } });

  assert.equal(calls.filter(model => model.startsWith('qwen/')).length, 1);
  assert.equal(calls.filter(model => model === 'gpt-6-luna').length, 2);
});

test('temporary OpenRouter in-flight credit holds skip its other models for the same account', async () => {
  const calls = [];
  const scheduler = new ModelScheduler();
  const charges = [];
  const request = async (_url, options) => {
    const model = JSON.parse(options.body).model;
    calls.push(model);
    if (model.startsWith('qwen/')) return { ...failure(402), json: async () => ({
      error: { message: 'This request would exceed your available credits given your current in-flight requests' },
    }) };
    return model === 'gpt-6-luna' ? failure(503) : response();
  };

  const result = await call({ request, scheduler, schedule: { kind: 'verification' },
    routing: { openrouterApiKey: 'router-key', budget: { reserve: async () => ({
      cancel() {}, complete: details => charges.push(details),
    }) } } });
  assert.equal(result._requestProvider, 'openai');
  assert.deepEqual(calls, ['qwen/qwen3.5-flash-02-23', 'gpt-6-luna', 'gpt-5.6-luna']);
  assert.ok(scheduler.state('openrouter:qwen/qwen3.5-flash-02-23').blockedUntil > 0);
  assert.equal(charges[0].preflightRejected, true);
  assert.equal(charges[0].usage, undefined);
});

test('recovery uses Qwen first and validates its structured source extraction', async () => {
  const result = await call({ schedule: { kind: 'recovery' }, request: async (_url, options) => {
    assert.equal(JSON.parse(options.body).model, 'qwen/qwen3.5-flash-02-23');
    return { ...response(), json: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }) };
  } });
  assert.equal(result._requestProvider, 'openrouter');
  assert.equal(result._requestModel, 'qwen/qwen3.5-flash-02-23');
});

test('missing OpenRouter credentials skip only its routes and all failures release slots', async () => {
  const scheduler = new ModelScheduler(), calls = [];
  await assert.rejects(call({ scheduler, routing: { openrouterApiKey: '' }, request: async (_url, options) => {
    calls.push(JSON.parse(options.body).model); return failure(500);
  } }), /All model routes failed/);
  assert.deepEqual(calls, ['gpt-6-luna', 'gpt-5.6-luna']);
  assert.equal(scheduler.queue.length, 0);
  assert.ok([...scheduler.models.values()].every(state => state.active === 0));
});

test('OpenRouter HTTP-200 provider errors trigger fallback and its reported cost is retained', async () => {
  let calls = 0;
  const ledger = [];
  const result = await call({ onUsage: e => ledger.push(e), request: async () => {
    calls++;
    if (calls === 1 || calls === 3) return failure(503);
    if (calls === 2) return response({ error: { code: 429, message: 'Provider rate limit' }, usage: undefined });
    return response({ usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, cost: 0.001 } });
  } });
  assert.equal(result._requestModel, 'openai/gpt-5.6-luna');
  assert.equal(ledger.at(-1).usage.reported_cost_usd, 0.001);
});

test('OpenRouter rate limits without Retry-After cool down the route instead of retrying every second', () => {
  const scheduler = new ModelScheduler();
  const model = 'openrouter:openai/gpt-6-luna';
  scheduler.state(model).active = 1;
  scheduler.finish(model, 1, { ok: false, status: 429, headers: new Headers() });
  assert.ok(scheduler.state(model).blockedUntil - Date.now() >= 59000);
  assert.equal(scheduler.state(model).requestsPerMinute, 20);
});
