const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzePage } = require('../page_analysis');
const { requestModel } = require('../model_router');
const { ModelScheduler } = require('../model_scheduler');
const { referenceSchema } = require('../page_evidence');
const { AiCost } = require('../ai_cost');
const qwen = require('../qwen_page');

test('review transport supplies explicit JSON shape as well as provider schema constraints', () => {
  const schema = { type: 'object', properties: { approved: { type: 'boolean' } },
    required: ['approved'], additionalProperties: false };
  const body = qwen.pageRequest({ instructions: 'Review this candidate.', input: 'Candidate evidence',
    text: { format: { name: 'research_review_batch_1', schema } } });

  assert.match(body.messages[0].content, /JSON/);
  assert.equal(body.messages[0].content.includes(JSON.stringify(schema)), true);
  assert.deepEqual(body.response_format.json_schema.schema, schema);
  assert.equal(body.response_format.json_schema.strict, true);
});

test('large Qwen review batches reserve less output credit while small reviews keep their allowance', () => {
  const child = { type: 'string', enum: ['review'] };
  const batch = count => ({ instructions: 'Review all candidates', input: '{}',
    max_output_tokens: 64 + count * 350,
    text: { format: { name: 'research_review_batch_1', schema: {
      type: 'object', properties: Object.fromEntries(Array.from({ length: count }, (_, index) =>
        [`R${index + 1}`, child])), additionalProperties: false,
    } } } });
  assert.equal(qwen.pageRequest(batch(16)).max_tokens, 64 + 16 * 280);
  assert.equal(qwen.pageRequest(batch(1)).max_tokens, 64 + 350);
});

const candidates = [{ name: 'Cinza Platinum', evidence_ids: [1, 2] }];
const output = JSON.stringify({ candidates });
const payload = { instructions: 'Keep every source.', input: '1| Volkswagen Gol\n2| LD7X Cinza Platinum',
  max_output_tokens: 8192, text: { format: { name: 'page_paint_references', schema: referenceSchema } } };

test('short page extraction limits unused Qwen output reservation without shortening the source', () => {
  const short = qwen.pageRequest(payload);
  assert.equal(short.max_tokens, 3072);
  assert.equal(short.messages[1].content, payload.input);
  const long = qwen.pageRequest({ ...payload, input: 'x'.repeat(20000) });
  assert.equal(long.max_tokens, 8192);
  assert.equal(long.messages[1].content.length, 20000);
});
const init = { headers: { Authorization: 'Bearer direct-test' }, body: JSON.stringify(payload) };
const response = (chat, text = output, extra = {}) => ({ ok: true, status: 200, json: async () => chat ? {
  choices: [{ finish_reason: 'stop', message: { content: text } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.00002 }, ...extra,
} : { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, ...extra } });
const failure = () => ({ ok: false, status: 503, json: async () => ({ error: { message: 'Unavailable' } }) });
const run = options => requestModel('https://api.openai.com/v1/responses', init, {
  scheduler: new ModelScheduler(), schedule: { kind: 'pageAnalysis' },
  routing: { openrouterApiKey: 'router-test' }, ...options,
});
const routes = [qwen.MODEL, 'gpt-6-luna', 'openai/gpt-6-luna', 'gpt-5.6-luna', 'openai/gpt-5.6-luna'];

test('Qwen keeps formal Brazilian names separate from generic descriptions', () => {
  assert.equal(qwen.formalName('Vermelho Metálico (Pearl Royalty Red)'), 'Pearl Royalty Red');
  assert.equal(qwen.formalName('Preto (Black)'), 'Black');
  assert.equal(qwen.formalName('Pearl Royalty Red (Water-Based Only)'), 'Pearl Royalty Red (Water-Based Only)');
  assert.equal(qwen.formalName('Prata (Hyper)'), 'Prata (Hyper)');
});

for (let success = 0; success < routes.length; success++) {
  test(`page extraction uses Qwen then the original four routes, success at ${success + 1}`, async () => {
    const calls = [], usage = [];
    const result = await run({ onUsage: entry => usage.push(entry), request: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.model);
      const chat = body.model === qwen.MODEL;
      assert.equal(url.endsWith('/chat/completions'), chat);
      assert.equal(options.headers.Authorization, url.includes('openrouter') ? 'Bearer router-test' : 'Bearer direct-test');
      if (chat) {
        assert.deepEqual(body.reasoning, { enabled: false });
        assert.equal(body.messages[1].content, payload.input);
        assert.match(body.messages[0].content, /Keep every source/);
        assert.deepEqual(body.response_format.json_schema.schema, referenceSchema);
        assert.deepEqual(body.transforms, []);
        assert.equal(body.service_tier, undefined);
      } else {
        assert.equal(body.input, payload.input);
        assert.equal(body.instructions, payload.instructions);
      }
      return calls.length <= success ? failure() : response(chat);
    } });
    assert.deepEqual(calls, routes.slice(0, success + 1));
    assert.equal(result._requestModel, routes[success]);
    assert.equal(usage.length, success + 1);
    assert.equal(usage.at(-1).model, routes[success]);
  });
}

test('main and matching keep their original GPT routes', async () => {
  for (const kind of ['research_plan', 'research_review', 'databaseMatcher']) {
    const result = await run({ schedule: { kind }, request: async (_url, options) => {
      assert.equal(JSON.parse(options.body).model, 'gpt-6-luna');
      return response(false);
    } });
    assert.equal(result._requestProvider, 'openai');
  }
});

test('Qwen recovery prompt follows verbatim-evidence schema without page-ID instructions', () => {
  const schema = { type: 'object', properties: { candidates: { type: 'array', items: {
    type: 'object', properties: { name: { type: 'string' },
      evidence: { type: 'array', items: { type: 'string' } } },
    required: ['name', 'evidence'], additionalProperties: false,
  } } }, required: ['candidates'], additionalProperties: false };
  const body = qwen.pageRequest({ instructions: 'Quote the original page text.', input: 'Hyundai ix35',
    text: { format: { name: 'recover_P1_1', schema } } });
  assert.match(body.messages[0].content, /Quote the original page text/);
  assert.doesNotMatch(body.messages[0].content, /Return only .*evidence_ids/);
  assert.deepEqual(body.response_format.json_schema.schema, schema);
});

test('final verification uses Qwen then the existing GPT fallback without changing main routes', async () => {
  const calls = [];
  const result = await run({ schedule: { kind: 'verification' }, request: async (_url, options) => {
    calls.push(JSON.parse(options.body).model);
    return calls.length === 1 ? failure() : response(false);
  } });
  assert.deepEqual(calls, [qwen.MODEL, 'gpt-6-luna']);
  assert.equal(result._requestModel, 'gpt-6-luna');
});

for (const kind of ['catalogResearch', 'targetedExtraction', 'candidateReview']) {
  test(`${kind} prefers Qwen and retains the original GPT fallbacks`, async () => {
    const calls = [];
    const result = await run({ schedule: { kind }, request: async (_url, options) => {
      calls.push(JSON.parse(options.body).model);
      return calls.length === 1 ? failure() : response(false);
    } });
    assert.deepEqual(calls, [qwen.MODEL, 'gpt-6-luna']);
    assert.equal(result._requestModel, 'gpt-6-luna');
  });
}

test('Qwen malformed/truncated/refused outputs fall back and preserve reported usage', async () => {
  for (const bad of [response(true, 'not json'), response(true, '{}'),
    response(true, output, { choices: [{ finish_reason: 'length', message: { content: output } }] }),
    response(true, output, { choices: [{ finish_reason: 'stop', message: { refusal: 'Refused' } }] })]) {
    let calls = 0;
    const ledger = new AiCost();
    const result = await run({ onUsage: entry => ledger.record('pageAnalysis', entry),
      request: async () => ++calls === 1 ? bad : response(false) });
    assert.equal(result._requestModel, 'gpt-6-luna');
    assert.equal(ledger.summary().entries.length, 2);
    assert.equal(ledger.summary().entries[0].providerReportedCostUsd, 0.00002);
  }
});

test('Qwen timeout releases capacity and proceeds to direct GPT-6', async () => {
  const scheduler = new ModelScheduler();
  let calls = 0;
  const timer = setInterval(() => {}, 20);
  try {
    const result = await run({ scheduler, routing: { openrouterApiKey: 'router-test', qwenTimeoutMs: 10 },
      request: async (_url, options) => ++calls === 1 ? new Promise((_, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })) : response(false) });
    assert.equal(result._requestModel, 'gpt-6-luna');
    assert.equal(scheduler.state(`openrouter:${qwen.MODEL}`).active, 0);
  } finally { clearInterval(timer); }
});

test('Qwen capacity saturation moves to direct GPT-6 without dropping work', async () => {
  const model = `openrouter:${qwen.MODEL}`;
  const scheduler = new ModelScheduler({ limits: { [model]: { concurrency: 1 } } });
  const occupied = await scheduler.acquire({ choices: [{ model }], tokens: 1 });
  const timer = setInterval(() => {}, 20);
  try {
    const result = await run({ scheduler, routing: { openrouterApiKey: 'router-test', capacityWaitMs: 10 },
      request: async (_url, options) => {
        assert.equal(JSON.parse(options.body).model, 'gpt-6-luna');
        return response(false);
      } });
    assert.equal(result._requestModel, 'gpt-6-luna');
    assert.equal(scheduler.queue.length, 0);
  } finally { occupied.complete({ ok: true }); clearInterval(timer); }
});

test('Brave/Qwen motorcycle extraction preserves formal names and ignores generic-only labels', async () => {
  const page = { url: 'https://source.test/cg160',
    text: 'Honda CG 160\nVermelho Metálico (Pearl Royalty Red)\nPreto (Black)' };
  const result = await analyzePage(page, { brand: 'Honda', model: 'CG 160', country: 'Brazil' }, {
    apiKey: 'direct-test', scheduler: new ModelScheduler(), modelRouting: { openrouterApiKey: 'router-test' },
    request: async () => response(true, JSON.stringify({ candidates: [
      { name: 'Vermelho Metálico (Pearl Royalty Red)', evidence_ids: [1, 2] },
      { name: 'Preto (Black)', evidence_ids: [1, 3] },
    ] })),
  });
  assert.deepEqual(result.candidates.map(c => c.name), ['Pearl Royalty Red']);
  assert.deepEqual(result.failures, []);
});

test('page integration restores Qwen citations and retries unsupported names on the next route', async () => {
  const page = { url: 'https://source.test/gol', text: 'Volkswagen Gol\nLD7X Cinza Platinum' };
  for (const bad of [false, true]) {
    const calls = [];
    const result = await analyzePage(page, { brand: 'Volkswagen', model: 'Gol', country: 'Brazil' }, {
      apiKey: 'direct-test', scheduler: new ModelScheduler(), modelRouting: { openrouterApiKey: 'router-test' },
      request: async (_url, options) => {
        const model = JSON.parse(options.body).model;
        calls.push(model);
        return response(model === qwen.MODEL, bad && model === qwen.MODEL
          ? JSON.stringify({ candidates: [{ name: 'Invented Silver', evidence_ids: [1] }] }) : output);
      },
    });
    assert.deepEqual(calls, bad ? routes.slice(0, 2) : routes.slice(0, 1));
    assert.deepEqual(result.candidates, [{ name: 'Cinza Platinum', evidence: [page.text] }]);
    assert.deepEqual(result.failures, []);
  }
});

test('missing OpenRouter key skips Qwen and uses direct GPT-6', async () => {
  const result = await run({ routing: { openrouterApiKey: '' }, request: async (_url, options) => {
    assert.equal(JSON.parse(options.body).model, 'gpt-6-luna');
    return response(false);
  } });
  assert.equal(result._requestModel, 'gpt-6-luna');
});

test('cancellation during Qwen does not start paid fallback work', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(run({ signal: controller.signal, request: async () => {
    calls++;
    controller.abort(new Error('Caller cancelled'));
    throw controller.signal.reason;
  } }), /Caller cancelled/);
  assert.equal(calls, 1);
});
