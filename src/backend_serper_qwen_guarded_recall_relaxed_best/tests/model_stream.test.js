const test = require('node:test');
const assert = require('node:assert/strict');
const { requestModel, routeTimeouts } = require('../model_router');
const { ModelScheduler } = require('../model_scheduler');
const { completeMembers, readModelStream } = require('../model_stream');
const { AiCost } = require('../ai_cost');
const { RunTiming } = require('../run_timing');
const { finalOutput } = require('../final_output');

const payload = { input: 'Evidence', instructions: 'Inspect evidence', max_output_tokens: 100,
  text: { format: { name: 'check', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } } } };
const data = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const delta = content => data({ choices: [{ index: 0, delta: { content } }] });
const jsonResponse = () => ({ ok: true, headers: new Headers(), json: async () => ({ status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
  usage: { input_tokens: 10, output_tokens: 2 } }) });
function stream(chunks, interval = 8, close = true) {
  let timer, offset = 0;
  return new Response(new ReadableStream({
    start(controller) {
      timer = setInterval(() => {
        if (offset < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[offset++]));
        else if (close) { clearInterval(timer); controller.close(); }
      }, interval);
    },
    cancel() { clearInterval(timer); },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
const call = (options, input = payload) => requestModel('https://api.openai.com/v1/responses', {
  headers: { Authorization: 'Bearer direct' }, body: JSON.stringify(input),
}, { scheduler: new ModelScheduler(), schedule: { kind: 'pageAnalysis' }, ...options });

test('an actively generating request hitting its absolute limit does not disable smaller sibling requests', async () => {
  const scheduler = new ModelScheduler();
  const models = [];
  const options = { scheduler,
    routing: { openrouterApiKey: 'router', qwenTimeoutMs: 150, firstContentMs: 100, idleMs: 100 },
    request: async (_url, init) => {
      const model = JSON.parse(init.body).model;
      models.push(model);
      if (models.length === 1) return stream(Array(100).fill(delta('a')), 5, false);
      if (!model.startsWith('qwen/')) return jsonResponse();
      return stream([delta('{"ok":true}'),
        data({ choices: [{ finish_reason: 'stop', delta: {} }] }),
        data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }), data('[DONE]')]);
    },
  };
  await call(options);
  await call(options);
  assert.deepEqual(models, ['qwen/qwen3.5-flash-02-23', 'gpt-6-luna', 'qwen/qwen3.5-flash-02-23']);
});

test('complete members preserve escaped/nested values but never accept unfinished siblings', () => {
  assert.deepEqual(completeMembers('{"R1":{"name":"A \\\" B", "ids":[1]},"R2":{"name":"unfinished'),
    { R1: { name: 'A \\" B'.replace('\\"', '"'), ids: [1] } });
  assert.deepEqual(completeMembers('{"R1":"unrelated_hue"'), { R1: 'unrelated_hue' });
  assert.deepEqual(completeMembers('{"V1":{"checks":[]}'), { V1: { checks: [] } });
  assert.deepEqual(completeMembers('{"R1":{"ok":true},"R2":'), { R1: { ok: true } });
});

test('parent deadline keeps completed streamed members without mutating the shared abort reason', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('Stage deadline'), { deadlineExceeded: true });
  let calls = 0, timer;
  try {
    await assert.rejects(call({ signal: controller.signal, allowPartialBatch: true,
      routing: { openrouterApiKey: 'router', qwenTimeoutMs: 1000, firstContentMs: 500, idleMs: 500 },
      request: async () => {
        calls++;
        timer = setTimeout(() => controller.abort(reason), 60);
        return stream([delta('{"R1":{"ok":true},"R2":')], 5, false);
      },
    }), error => {
      assert.deepEqual(error.partialOutput, { R1: { ok: true } });
      assert.equal(error.deadlineExceeded, true);
      assert.notEqual(error, reason);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(reason.partialOutput, undefined);
  } finally { clearTimeout(timer); }
});

test('active chat content extends the idle allowance and records final usage exactly once', async () => {
  const usage = [], events = [];
  let calls = 0;
  const result = await call({ onUsage: entry => usage.push(entry), onWait: event => events.push(event),
    routing: { openrouterApiKey: 'router', qwenTimeoutMs: 500, firstContentMs: 100, idleMs: 90 },
    request: async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      assert.equal(body.stream, true);
      assert.deepEqual(body.stream_options, { include_usage: true });
      return stream([delta('{'), delta('"ok"'), delta(':'), delta('true'), delta('}'),
        data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.0002 } }), data('[DONE]')], 20);
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'completed');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].usage.reported_cost_usd, 0.0002);
  assert.equal(events.filter(event => event.event === 'model_first_content').length, 1);
});

test('a productive stream can use its stage window beyond the initial fallback reserve', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  const signal = timing.deadlineAt(650);
  let calls = 0;
  try {
    const result = await call({ timing, signal,
      routing: { openrouterApiKey: 'router', qwenTimeoutMs: 1000, firstContentMs: 300, idleMs: 200, minimumAttemptWindowMs: 0 },
      request: async () => {
        calls++;
        return stream([delta('{'), delta('"ok"'), delta(':'), delta('true'), delta('}'),
          data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
          data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } }), data('[DONE]')], 60);
      } });
    assert.equal(result.status, 'completed');
    assert.equal(calls, 1);
  } finally { timing.close(); }
});

for (const kind of ['heartbeat', 'idle', 'absolute']) {
  test(`${kind} stall cancels the stream, falls back and marks missing usage`, async () => {
    let calls = 0;
    const events = [], cost = new AiCost();
    const result = await call({ onWait: event => events.push(event), onUsage: entry => cost.record('page', entry),
      routing: { openrouterApiKey: 'router', qwenTimeoutMs: kind === 'absolute' ? 60 : 180,
        firstContentMs: 40, idleMs: 30 },
      request: async () => ++calls > 1 ? jsonResponse() : stream(kind === 'heartbeat'
        ? Array(100).fill(': OPENROUTER PROCESSING\n\n')
        : kind === 'idle' ? [delta('{')] : Array(100).fill(delta('a')), 5, false),
    });
    assert.equal(result._requestProvider, 'openai');
    assert.equal(calls, 2);
    const fallback = events.find(event => event.code === 'MODEL_ROUTE_TIMEOUT');
    assert.equal(fallback.phase, kind === 'heartbeat' ? 'first_content' : kind === 'idle' ? 'idle' : 'response_body');
    const output = finalOutput({ colors: [], research: { status: 'partial' }, cost: cost.summary(), serperCost: { estimatedCostUsd: 0.001 } });
    assert.equal(output.usage.missingUsageCalls, 1);
    assert.equal(output.usage.costComplete, false);
    assert.equal(output.usage.estimatedCostUsd, null);
    assert.equal(output.totalEstimatedCostUsd, null);
    assert.ok(output.usage.knownCostUsd > 0);
  });
}

test('Responses SSE handles CRLF and chunk boundaries and returns the terminal response', async () => {
  const terminal = await jsonResponse().json();
  const text = data({ type: 'response.output_text.delta', delta: '{"ok":true}' }).replaceAll('\n', '\r\n')
    + data({ type: 'response.completed', response: terminal });
  let progress = 0;
  const result = await readModelStream(stream([text.slice(0, 17), text.slice(17, 55), text.slice(55)]), {
    chat: false, signal: new AbortController().signal, progress: () => progress++, state: {},
  });
  assert.deepEqual(result, terminal);
  assert.equal(progress, 1);
});

test('truncated and error streams cannot become successful structured output', async () => {
  for (const chunks of [[delta('{"ok":true}')], [data({ error: { code: 429, message: 'Slow down' } })]]) {
    await assert.rejects(readModelStream(stream(chunks), {
      chat: true, signal: new AbortController().signal, progress: () => {}, state: {},
    }), /without completion|Slow down/);
  }
});

test('larger complete requests get bounded workload allowance; explicit caps still win', () => {
  const small = routeTimeouts('pageAnalysis', 16000, {}, {}, payload);
  const large = routeTimeouts('pageAnalysis', 16000, {}, {}, { ...payload, input: 'x'.repeat(80000) });
  assert.ok(large.qwenMs > small.qwenMs);
  assert.ok(large.firstContentMs > small.firstContentMs);
  assert.ok(large.qwenMs <= 12000);
  assert.equal(routeTimeouts('candidateReview', 5000, {}, {}, payload).qwenMs, 5000);
  assert.equal(routeTimeouts('candidateReview', 16000, { qwenTimeoutMs: 99 }, {}, payload).qwenMs, 99);
});

test('batch timeout returns complete children and the failed route before sending a fallback', async () => {
  let calls = 0;
  await assert.rejects(call({ splitOnTimeout: true,
    routing: { openrouterApiKey: 'router', qwenTimeoutMs: 100, idleMs: 20 },
    request: async () => { calls++; return stream([delta('{"R1":{"ok":true},"R2":')], 5, false); },
  }), error => {
    assert.equal(error.code, 'MODEL_ROUTE_TIMEOUT');
    assert.equal(error.routeId, 'openrouter:qwen/qwen3.5-flash-02-23');
    assert.deepEqual(error.partialOutput, { R1: { ok: true } });
    return true;
  });
  assert.equal(calls, 1);
});

test('output length limits preserve complete batch members without rerunning their siblings', async () => {
  let calls = 0;
  const batch = { ...payload, text: { format: { name: 'review_batch', schema: {
    type: 'object', properties: { R1: payload.text.format.schema, R2: payload.text.format.schema },
    required: ['R1', 'R2'], additionalProperties: false,
  } } } };
  await assert.rejects(call({ allowPartialBatch: true,
    routing: { openrouterApiKey: 'router' }, request: async () => {
      calls++;
      return stream([delta('{"R1":{"ok":true},"R2":{"ok":'),
        data({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
        data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 10 } }), data('[DONE]')]);
    } }, batch), error => {
    assert.equal(error.code, 'MODEL_PARTIAL_OUTPUT');
    assert.deepEqual(error.partialOutput, { R1: { ok: true } });
    assert.equal(error.routeId, 'openrouter:qwen/qwen3.5-flash-02-23');
    return true;
  });
  assert.equal(calls, 1);
});

test('fully invalid batch members fall back instead of suppressing the next provider', async () => {
  let calls = 0;
  const batch = { ...payload, text: { format: { name: 'review_batch', schema: {
    type: 'object', properties: { R1: payload.text.format.schema, R2: payload.text.format.schema },
    required: ['R1', 'R2'], additionalProperties: false,
  } } } };
  const result = await call({ allowPartialBatch: true,
    routing: { openrouterApiKey: 'router' }, request: async () => {
      if (++calls === 1) return stream([delta('{"R1":{"ok":"wrong type"},"R2":'),
        data({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
        data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 10 } }), data('[DONE]')]);
      return { ok: true, headers: new Headers(), json: async () => ({ status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"R1":{"ok":true},"R2":{"ok":false}}' }] }],
        usage: { input_tokens: 10, output_tokens: 10 } }) };
    } }, batch);
  assert.equal(calls, 2);
  assert.equal(result._requestProvider, 'openai');
});
