const test = require('node:test');
const assert = require('node:assert/strict');

const { reasoningPayload, structuredRequest } = require('../request_envelope');

test('Qwen-capable helper stages send explicit bounded output allowances', () => {
  const schema = { type: 'object', properties: { candidates: { type: 'array', items: { type: 'string' } } },
    required: ['candidates'], additionalProperties: false };
  const input = { candidates: [] };
  assert.equal(structuredRequest('recover_P1_1', schema, input, 'Recover').max_output_tokens, 4096);
  assert.equal(structuredRequest('catalog_check_1', schema, input, 'Check').max_output_tokens, 2048);
  assert.equal(structuredRequest('extract_details_C1', schema, input, 'Extract').max_output_tokens, 2048);
  assert.equal(structuredRequest('research_review_omission_C1_retry', schema, input, 'Repair').max_output_tokens, 2048);
});

test('reasoning routes reserve space beyond a compact visible answer without changing its evidence', () => {
  const payload = { input: 'Full evidence', reasoning: { effort: 'low' }, max_output_tokens: 414 };
  for (const provider of ['openai', 'openrouter']) {
    assert.deepEqual(reasoningPayload({ provider }, payload), { ...payload, max_output_tokens: 2048 });
  }
  assert.equal(reasoningPayload({ chat: true }, payload), payload);
  assert.equal(reasoningPayload({ provider: 'gemini' }, payload), payload);
  assert.equal(reasoningPayload({}, { ...payload, max_output_tokens: 4000 }).max_output_tokens, 5024);
  assert.equal(reasoningPayload({}, { ...payload, reasoning: { effort: 'none' } }).max_output_tokens, 414);
  assert.equal(payload.max_output_tokens, 414);
});
