const test = require('node:test');
const assert = require('node:assert/strict');
const gemini = require('../gemini_page');
const qwen = require('../qwen_page');
const { requestModel } = require('../model_router');
const { ModelScheduler, retryAfterMs } = require('../model_scheduler');
const { analyzePage } = require('../page_analysis');
const { referenceSchema } = require('../page_evidence');
const { AiCost } = require('../ai_cost');
const { finalOutput } = require('../final_output');

const candidates = [{ name: 'Cinza Platinum', evidence_ids: [1, 2] }];
const output = JSON.stringify({ candidates });
const payload = { instructions: 'Keep every source.', input: '1| Volkswagen Gol\n2| LD7X Cinza Platinum',
  max_output_tokens: 8192, text: { format: { name: 'page_paint_references', schema: referenceSchema } } };
const init = { headers: { Authorization: 'Bearer direct-test' }, body: JSON.stringify(payload) };
const routing = { openrouterApiKey: 'router-test', geminiApiKey: 'google-test' };
const failure = () => ({ ok: false, status: 503, json: async () => ({ error: { message: 'Unavailable' } }) });
const googleBody = (text = output, extra = {}) => ({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'Private thinking' }, { text }] } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5,
    cachedContentTokenCount: 40, totalTokenCount: 125 }, ...extra,
});
const success = body => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
const run = options => requestModel('https://api.openai.com/v1/responses', init, {
  scheduler: new ModelScheduler(), schedule: { kind: 'pageAnalysis' }, routing, ...options,
});
const originalRoutes = [qwen.MODEL, 'gpt-6-luna', 'openai/gpt-6-luna', 'gpt-5.6-luna', 'openai/gpt-5.6-luna'];

test('Google is the sixth page route, with isolated credentials and unchanged source/schema', async () => {
  const calls = [], ledger = new AiCost();
  const result = await run({ onUsage: entry => ledger.record('pageAnalysis', entry), request: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.model || gemini.MODEL);
    if (calls.length < 6) return failure();
    assert.equal(url, gemini.API_URL);
    assert.equal(options.headers['x-goog-api-key'], 'google-test');
    assert.equal(options.headers.Authorization, undefined);
    assert.deepEqual(body, gemini.pageRequest(payload));
    assert.equal(body.contents[0].parts[0].text, payload.input);
    assert.equal(body.systemInstruction.parts[0].text, payload.instructions);
    assert.deepEqual(body.generationConfig.responseFormat.text.schema, referenceSchema);
    assert.equal(body.generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
    return success(googleBody());
  } });
  assert.deepEqual(calls, [...originalRoutes, gemini.MODEL]);
  assert.equal(result._requestProvider, 'gemini');
  assert.equal(result._requestModel, gemini.MODEL);
  assert.equal(result.output[0].content[0].text, output);
  assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 25, total_tokens: 125, cached_input_tokens: 40 });
  const entry = ledger.summary().entries.at(-1);
  assert.equal(entry.provider, 'gemini');
  assert.equal(entry.model, gemini.MODEL);
  assert.equal(entry.outputTokens, 25);
  assert.ok(Math.abs(entry.estimatedCostUsd - 0.0000817) < 1e-12);
  const report = finalOutput({ colors: [], research: { status: 'complete' }, cost: ledger.summary() });
  assert.equal(report.usage.byModel.at(-1).model, gemini.MODEL);
});

test('main, recovery and code matching never use Google when every eligible route fails', async () => {
  for (const kind of ['main', 'research_plan', 'research_review', 'recovery', 'databaseMatcher']) {
    const calls = [];
    await assert.rejects(run({ schedule: { kind }, request: async (url, options) => {
      assert.notEqual(url, gemini.API_URL);
      calls.push(JSON.parse(options.body).model);
      return failure();
    } }), /All model routes failed/);
    assert.deepEqual(calls, kind === 'recovery' ? originalRoutes : originalRoutes.slice(1));
  }
});

test('an earlier successful route never calls Google', async () => {
  let calls = 0;
  await run({ request: async (url) => {
    calls++;
    assert.equal(url, qwen.API_URL);
    return success({ choices: [{ finish_reason: 'stop', message: { content: output } }] });
  } });
  assert.equal(calls, 1);
});

test('missing Google key skips the final route', async () => {
  let calls = 0;
  await assert.rejects(run({ routing: { ...routing, geminiApiKey: '' }, request: async url => {
    calls++;
    assert.notEqual(url, gemini.API_URL);
    return failure();
  } }), /All model routes failed/);
  assert.equal(calls, 5);
});

test('invalid, truncated and safety-blocked Google output fails without losing reported usage', async () => {
  for (const body of [googleBody('invalid JSON'), googleBody('{}'),
    googleBody(output, { candidates: [{ finishReason: 'MAX_TOKENS' }] }),
    googleBody(output, { candidates: [], promptFeedback: { blockReason: 'SAFETY' } })]) {
    const ledger = [], scheduler = new ModelScheduler();
    await assert.rejects(run({ scheduler, onUsage: entry => ledger.push(entry),
      request: async url => url === gemini.API_URL ? success(body) : failure() }), /All model routes failed/);
    assert.equal(ledger.length, 6);
    assert.equal(ledger.at(-1).usage.output_tokens, 25);
    assert.ok([...scheduler.models.values()].every(state => state.active === 0));
  }
});

test('Google extraction restores literal Brazilian paint names and rejects unsupported citations', async () => {
  const page = { url: 'https://source.test/gol', text: 'Volkswagen Gol\nLD7X Cinza Platinum' };
  for (const bad of [false, true]) {
    const result = await analyzePage(page, { brand: 'Volkswagen', model: 'Gol', country: 'Brazil' }, {
      apiKey: 'direct-test', scheduler: new ModelScheduler(), modelRouting: routing,
      request: async url => url === gemini.API_URL ? success(googleBody(bad
        ? JSON.stringify({ candidates: [{ name: 'Invented Silver', evidence_ids: [1] }] }) : output)) : failure(),
    });
    assert.deepEqual(result.candidates, bad ? [] : [{ name: 'Cinza Platinum', evidence: [page.text] }]);
    assert.equal(result.failures.length, bad ? 1 : 0);
    assert.equal(result.requests, 6);
  }
});

test('completeness audits can also use the Google fallback and retain additional names', async () => {
  const page = { url: 'https://source.test/gol', text: 'Volkswagen Gol\n'
    + Array.from({ length: 60 }, (_, i) => `Cinza Platinum ${i} - published factory paint for Gol`).join('\n') };
  const calls = [];
  const result = await analyzePage(page, { brand: 'Volkswagen', model: 'Gol', country: 'Brazil' }, {
    apiKey: 'direct-test', scheduler: new ModelScheduler(), modelRouting: routing,
    request: async (url, options) => {
      if (url !== gemini.API_URL) return failure();
      const body = JSON.parse(options.body);
      const audit = body.contents[0].parts[0].text.includes('Independent completeness audit');
      calls.push(audit);
      return success(googleBody(JSON.stringify({ candidates: [{ name: `Cinza Platinum ${audit ? 1 : 0}`,
        evidence_ids: [1, audit ? 3 : 2] }] })));
    },
  });
  assert.deepEqual(calls, [false, true]);
  assert.deepEqual(result.candidates.map(entry => entry.name), ['Cinza Platinum 0', 'Cinza Platinum 1']);
  assert.deepEqual(result.failures, []);
});

test('final Google timeout releases its slot and reports exhausted routes', async () => {
  const scheduler = new ModelScheduler();
  const timer = setInterval(() => {}, 20);
  try {
    await assert.rejects(run({ scheduler, routing: { ...routing, geminiTimeoutMs: 10 },
      request: async (url, options) => url !== gemini.API_URL ? failure() : new Promise((_, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })) }), /All model routes failed/);
    assert.equal(scheduler.state(`gemini:${gemini.MODEL}`).active, 0);
    assert.equal(scheduler.queue.length, 0);
  } finally { clearInterval(timer); }
});

test('Google error messages redact credentials and preserve retry details', async () => {
  const body = { error: { code: 429, message: 'Rate limit google-test',
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '15.5s' }] } };
  assert.equal(retryAfterMs(new Headers(), gemini.normalizeResponse(body)), 15500);
  const scheduler = new ModelScheduler();
  await assert.rejects(run({ scheduler, request: async url => url !== gemini.API_URL ? failure()
    : { ok: false, status: 429, headers: new Headers(), json: async () => body } }), error => {
    assert.doesNotMatch(error.message, /google-test/);
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
  assert.ok(scheduler.state(`gemini:${gemini.MODEL}`).blockedUntil - Date.now() > 15000);
});
