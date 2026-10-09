const test = require('node:test');
const assert = require('node:assert/strict');
const { AiCost } = require('../ai_cost');

test('cost estimates account for actual cache usage, output tokens and fast tier', () => {
  const cost = new AiCost();
  cost.record('pageAnalysis', { provider: 'openai', model: 'gpt-6-luna', usage: {
    input_tokens: 100000, cached_input_tokens: 50000, output_tokens: 10000 } });
  cost.record('main', { provider: 'openai', model: 'gpt-6-luna', serviceTier: 'priority',
    usage: { input_tokens: 10000, output_tokens: 1000 } });
  assert.equal(cost.summary().estimatedCostUsd, 0.0135);
  assert.equal(cost.summary().uncachedCostUsd, 0.018);
  assert.equal(cost.summary(0.01).overTarget, true);
});

test('unknown pricing and missing usage are not presented as zero cost', () => {
  const cost = new AiCost();
  assert.equal(cost.summary().estimatedCostUsd, null);
  cost.record('main', { provider: 'openai', model: 'unknown', usage: { input_tokens: 1 } });
  assert.equal(cost.summary().estimatedCostUsd, null);
  const missing = new AiCost();
  missing.record('main', { provider: 'openai', model: 'gpt-6-luna' });
  assert.equal(missing.summary().estimatedCostUsd, null);
});

test('secondary OpenAI extraction has its own model usage and standard-tier cost', () => {
  const cost = new AiCost();
  cost.record('pageAnalysis', { provider: 'openai', model: 'gpt-5.6-luna', usage: {
    input_tokens: 100000, cached_input_tokens: 50000, output_tokens: 10000 } });
  assert.equal(cost.summary().estimatedCostUsd, 0.023);
  assert.equal(cost.summary().uncachedCostUsd, 0.032);
  assert.equal(cost.summary().entries[0].model, 'gpt-5.6-luna');
});

test('missing provider usage keeps exact cost unknown but bounds a capped request', () => {
  const cost = new AiCost();
  cost.record('pageAnalysis', { provider: 'openrouter', model: 'qwen/qwen3.5-flash-02-23',
    requestBytes: 5000, maxOutputTokens: 1000 });
  const summary = cost.summary();
  assert.equal(summary.estimatedCostUsd, null);
  assert.equal(summary.missingUsageCalls, 1);
  assert.equal(summary.upperBoundUsd, Number((((5000 + 1024) * 0.065 + 1000 * 0.26) / 1e6).toFixed(6)));
});
