const test = require('node:test');
const assert = require('node:assert/strict');
const { PageBatcher } = require('../page_batcher');
const { ModelScheduler } = require('../model_scheduler');

test('page batching preserves per-page names and counts one HTTP request and usage entry', async () => {
  const batcher = new PageBatcher({ size: 4 });
  const signal = new AbortController().signal;
  const scheduler = new ModelScheduler();
  let requests = 0, usageEntries = 0, attempts = 0;
  const pending = ['Ice White', 'Shimmering Silver', 'Branco Lunar', 'Prata Shark'].map(name => {
    const body = { instructions: 'Extract each complete paint name', input: name,
      text: { format: { name: 'page_paint_references', schema: { type: 'object', properties: {
        candidates: { type: 'array', items: { type: 'object' } },
      }, required: ['candidates'] } } } };
    return batcher.add('https://api.openai.com/v1/responses', {
      headers: { Authorization: 'Bearer test-key' }, body: JSON.stringify(body),
    }, { signal, scheduler, routing: { openrouterApiKey: '', geminiApiKey: '' }, schedule: { kind: 'pageAnalysis' },
      onUsage: () => usageEntries++, onAttempt: () => attempts++,
      validateOutput: value => assert.equal(value.candidates[0].name, name),
      request: async (_url, init) => {
        requests++;
        const pages = JSON.parse(JSON.parse(init.body).input);
        assert.equal(pages.length, 4);
        const value = Object.fromEntries(pages.map(page => [page.id, {
          candidates: [{ name: page.page, evidence_ids: [1] }],
        }]));
        return { ok: true, status: 200, json: async () => ({ status: 'completed',
          usage: { input_tokens: 100, output_tokens: 20 },
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
        }) };
      },
    });
  });
  const results = await Promise.all(pending);
  assert.equal(results.length, 4);
  assert.equal(requests, 1);
  assert.equal(attempts, 1);
  assert.equal(usageEntries, 1);
});

test('aborted page batches make no HTTP request', async () => {
  const batcher = new PageBatcher();
  const controller = new AbortController();
  const result = batcher.add('unused', { body: JSON.stringify({ input: 'page' }) }, {
    signal: controller.signal, request: () => assert.fail('Unexpected request'),
  });
  controller.abort(new Error('Cancelled'));
  await assert.rejects(result, /Cancelled/);
});

test('timed-out page transport splits before switching to the next model', async () => {
  const batcher = new PageBatcher({ size: 4 });
  const scheduler = new ModelScheduler();
  const signal = new AbortController().signal;
  const sent = [];
  const results = await Promise.all(['One', 'Two', 'Three', 'Four'].map(name => batcher.add(
    'https://api.openai.com/v1/responses', {
      headers: { Authorization: 'Bearer direct' }, body: JSON.stringify({ instructions: 'Extract', input: name,
        text: { format: { name: 'extract', schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } }),
    }, {
      scheduler, signal, schedule: { kind: 'pageAnalysis' }, routing: { openrouterApiKey: 'router', qwenTimeoutMs: 20 },
      validateOutput: value => assert.equal(value.name, name),
      request: async (_url, init) => {
        const body = JSON.parse(init.body);
        sent.push(body.model);
        if (sent.length === 1) return new Promise(() => {});
        const pages = JSON.parse(body.input);
        assert.equal(pages.length, 2);
        const value = Object.fromEntries(pages.map(page => [page.id, { name: page.page }]));
        return { ok: true, json: async () => ({ status: 'completed', usage: { input_tokens: 1, output_tokens: 1 },
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
        }) };
      },
    },
  )));
  assert.equal(results.length, 4);
  assert.deepEqual(sent, ['qwen/qwen3.5-flash-02-23', 'gpt-6-luna', 'gpt-6-luna']);
  assert.ok([...scheduler.models.values()].every(state => state.active === 0));
});

test('streamed page siblings retain provider-specific grounding checks and attribution', async () => {
  const batcher = new PageBatcher({ size: 2 });
  const scheduler = new ModelScheduler();
  const signal = new AbortController().signal;
  const validated = [], sent = [];
  const results = await Promise.all(['One', 'Two'].map(name => batcher.add(
    'https://api.openai.com/v1/responses', {
      headers: { Authorization: 'Bearer direct' }, body: JSON.stringify({ instructions: 'Extract', input: name,
        text: { format: { name: 'extract', schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } }),
    }, {
      scheduler, signal, schedule: { kind: 'pageAnalysis' }, routing: { openrouterApiKey: 'router', qwenTimeoutMs: 40 },
      validateOutput: (value, route) => {
        validated.push(route.model);
        assert.equal(value.name, name);
      },
      request: async (_url, init) => {
        const body = JSON.parse(init.body);
        sent.push(body.model);
        if (sent.length === 1) return new Response(new ReadableStream({ start(controller) {
          const content = '{"P1":{"name":"One"},"P2":{"name":"Invented"},';
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`));
        } }), { headers: { 'content-type': 'text/event-stream' } });
        assert.equal(body.input, 'Two');
        return { ok: true, json: async () => ({ status: 'completed', usage: { input_tokens: 1, output_tokens: 1 },
          output: [{ type: 'message', content: [{ type: 'output_text', text: '{"name":"Two"}' }] }],
        }) };
      },
    },
  )));
  assert.deepEqual(sent, ['qwen/qwen3.5-flash-02-23', 'gpt-6-luna']);
  assert.deepEqual(validated, ['qwen/qwen3.5-flash-02-23', 'qwen/qwen3.5-flash-02-23', 'gpt-6-luna']);
  assert.equal(results[0]._requestModel, 'qwen/qwen3.5-flash-02-23');
  assert.equal(results[1]._requestModel, 'gpt-6-luna');
});
