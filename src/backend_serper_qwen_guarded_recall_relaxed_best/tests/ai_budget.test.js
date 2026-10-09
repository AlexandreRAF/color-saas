const test = require('node:test');
const assert = require('node:assert/strict');
const { AiBudget } = require('../ai_budget');
const route = { provider: 'openai', model: 'gpt-6-luna', serviceTier: 'fast' };
const payload = { input: 'small' };
const usage = usd => ({ ...route, usage: { input_tokens: usd * 1e6 / 0.2, output_tokens: 0 } });

test('budget admission includes the actual route output limit for every stage', async () => {
  const budget = new AiBudget(0.004);
  await assert.rejects(budget.reserve(route, { input: 'small', max_output_tokens: 5000 }, 'verification'),
    { code: 'AI_BUDGET_LIMIT' });
  assert.equal(budget.pending.size, 0);
});

test('GPT admission includes its reasoning output allowance', async () => {
  const budget = new AiBudget(0.06);
  const request = { input: '{}', max_output_tokens: 2000, reasoning: { effort: 'low' } };
  const ticket = await budget.reserve(route, request, 'candidateReview');
  const withReasoning = [...budget.pending][0].estimate;
  ticket.cancel();
  const plain = await budget.reserve(route, { ...request, reasoning: { effort: 'none' } }, 'candidateReview');
  const withoutReasoning = [...budget.pending][0].estimate;
  plain.cancel();
  assert.ok(withReasoning > withoutReasoning);
});

test('Qwen budget admission uses the output allowance sent to OpenRouter', async () => {
  const budget = new AiBudget(0.06);
  const qwenRoute = { provider: 'openrouter', model: 'qwen/qwen3.5-flash-02-23',
    serviceTier: 'default', chat: true };
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } },
    required: ['ok'], additionalProperties: false };
  const request = { input: '{}', instructions: 'Check source', text: { format: { name: 'catalog_check_1', schema } } };
  const defaultTicket = await budget.reserve(qwenRoute, request, 'catalogResearch');
  const defaultEstimate = [...budget.pending][0].estimate;
  defaultTicket.cancel();
  const boundedTicket = await budget.reserve(qwenRoute, { ...request, max_output_tokens: 2048 }, 'catalogResearch');
  const boundedEstimate = [...budget.pending][0].estimate;
  boundedTicket.cancel();
  assert.ok(defaultEstimate > boundedEstimate);
});

test('AI budget keeps 20 percent for code matching and 40 percent for page extraction', async () => {
  const budget = new AiBudget(0.06);
  const page = await budget.reserve(route, payload, 'pageAnalysis');
  page.complete(usage(0.025));
  await assert.rejects(budget.reserve(route, payload, 'pageAnalysis'), error => {
    assert.equal(error.code, 'AI_BUDGET_LIMIT');
    assert.ok(error.details.pageSpentUsd >= error.details.pageLimitUsd);
    return true;
  });
  const review = await budget.reserve(route, payload, 'main');
  review.complete(usage(0.024));
  await assert.rejects(budget.reserve(route, payload, 'main'), { code: 'AI_BUDGET_LIMIT' });
  const matcher = await budget.reserve(route, payload, 'databaseMatcher');
  matcher.complete(usage(0.005));
  assert.ok(Math.abs(budget.spent - 0.054) < 1e-9);
});

test('concurrent budget reservations wait for actual usage and release once', async () => {
  const budget = new AiBudget(0.004);
  const first = await budget.reserve(route, payload, 'pageAnalysis');
  let admitted = false;
  const second = budget.reserve(route, payload, 'pageAnalysis').then(ticket => { admitted = true; return ticket; });
  await Promise.resolve();
  assert.equal(admitted, false);
  first.complete(usage(0.0001));
  first.complete(usage(1));
  (await second).complete(usage(0.0001));
  assert.equal(budget.pending.size, 0);
  assert.ok(budget.spent < 0.001);
});

test('budget waits honor cancellation and unknown usage is not free', async () => {
  const budget = new AiBudget(0.004);
  const first = await budget.reserve(route, payload, 'pageAnalysis');
  const controller = new AbortController();
  const second = budget.reserve(route, payload, 'pageAnalysis', controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(second, /cancelled/);
  first.complete();
  assert.ok(budget.spent > 0);
  assert.equal(budget.waiters.size, 0);
});

test('a documented preflight credit hold retains input admission without reserving ungenerated output', async () => {
  const budget = new AiBudget(0.06);
  const request = { ...payload, max_output_tokens: 4000 };
  const rejected = await budget.reserve(route, request, 'candidateReview');
  rejected.complete({ preflightRejected: true });
  const preflightCharge = budget.spent;
  assert.ok(preflightCharge > 0);

  const unknown = await budget.reserve(route, request, 'candidateReview');
  unknown.complete();
  assert.ok(budget.spent - preflightCharge > preflightCharge);
});

test('final verification has reserved room inside the shared total cost target', async () => {
  const budget = new AiBudget(0.06, {}, { verificationFraction: 0.1 });
  const matcher = await budget.reserve(route, payload, 'databaseMatcher');
  matcher.complete(usage(0.054));
  await assert.rejects(budget.reserve(route, payload, 'databaseMatcher'), { code: 'AI_BUDGET_LIMIT' });
  const verifier = await budget.reserve(route, payload, 'verification');
  verifier.complete(usage(0.006));
  await assert.rejects(budget.reserve(route, payload, 'verification'), { code: 'AI_BUDGET_LIMIT' });
});

test('cancelled unsent reservations refund budget without charging estimated usage', async () => {
  const budget = new AiBudget(0.004);
  const first = await budget.reserve(route, payload, 'pageAnalysis');
  const second = budget.reserve(route, payload, 'pageAnalysis');
  first.cancel();
  first.cancel();
  (await second).cancel();
  assert.equal(budget.pending.size, 0);
  assert.equal(budget.spent, 0);
});

test('overlapping matching cannot spend the protected candidate-review allowance', async () => {
  const budget = new AiBudget(0.06, {}, { verificationFraction: 0.1, reviewFraction: 0.35 });
  const page = await budget.reserve(route, payload, 'pageAnalysis');
  page.complete(usage(0.024));
  const matcher = await budget.reserve(route, payload, 'databaseMatcher');
  matcher.complete(usage(0.009));

  await assert.rejects(budget.reserve(route, payload, 'databaseMatcher'), { code: 'AI_BUDGET_LIMIT' });
  const review = await budget.reserve(route, payload, 'candidateReview');
  review.complete(usage(0.006));
  assert.ok(Math.abs(budget.reviewSpent - 0.006) < 1e-9);
  await assert.rejects(budget.reserve(route, payload, 'databaseMatcher'), { code: 'AI_BUDGET_LIMIT' });

  budget.finishReviews();
  (await budget.reserve(route, payload, 'databaseMatcher')).cancel();
});

test('pending reviews protect their funds without counting reservations twice', async () => {
  const budget = new AiBudget(0.06, {}, { verificationFraction: 0.1, reviewFraction: 0.35 });
  const review = await budget.reserve(route, payload, 'candidateReview');
  const page = await budget.reserve(route, payload, 'pageAnalysis');
  page.cancel();
  review.cancel();
  assert.equal(budget.reviewSpent, 0);
  assert.equal(budget.pending.size, 0);
  assert.throws(() => new AiBudget(0.06, {}, { reviewFraction: -1 }), /reviewFraction/);
});

test('settled exclusions release unused verification allowance without increasing the total target', async () => {
  const budget = new AiBudget(0.06, {}, { verificationFraction: 0.2, reviewFraction: 0.35 });
  const review = await budget.reserve(route, payload, 'candidateReview');
  review.complete(usage(0.048));
  await assert.rejects(budget.reserve(route, payload, 'candidateReview'), { code: 'AI_BUDGET_LIMIT' });

  budget.setVerificationWorkload(30);
  assert.ok(Math.abs(budget.verificationReserve - 0.0055) < 1e-9);
  const retry = await budget.reserve(route, payload, 'candidateReview');
  retry.complete(usage(0.0065));
  await assert.rejects(budget.reserve(route, payload, 'candidateReview'), { code: 'AI_BUDGET_LIMIT' });
  budget.finishReviews();
  const verifier = await budget.reserve(route, payload, 'verification');
  verifier.complete(usage(0.0055));
  await assert.rejects(budget.reserve(route, payload, 'verification'), { code: 'AI_BUDGET_LIMIT' });
  assert.ok(Math.abs(budget.spent - 0.06) < 1e-9);
});

test('large or unresolved palettes retain the full verification allowance', () => {
  const budget = new AiBudget(0.06, {}, { verificationFraction: 0.2 });
  budget.setVerificationWorkload(200);
  assert.equal(budget.verificationReserve, 0.012);
  budget.setVerificationWorkload(0);
  assert.equal(budget.verificationReserve, 0.003);
  assert.throws(() => budget.setVerificationWorkload(-1), /workload/);
  assert.throws(() => budget.setVerificationWorkload(1.5), /workload/);
  const disabled = new AiBudget(0.06);
  disabled.setVerificationWorkload(200);
  assert.equal(disabled.verificationReserve, 0);
});

test('omission audit funds survive normal reviews and can be released after the audit', async () => {
  const budget = new AiBudget(0.06, {}, { omissionFraction: 0.15, matchingFraction: 0.1, verificationFraction: 0.1 });
  const review = await budget.reserve(route, payload, 'candidateReview');
  review.complete(usage(0.039));
  await assert.rejects(budget.reserve(route, payload, 'candidateReview'), { code: 'AI_BUDGET_LIMIT' });
  const audit = await budget.reserve(route, { ...payload, text: { format: { name: 'final_verification_omissions_1' } } }, 'verification');
  audit.complete(usage(0.004));
  assert.equal(budget.stageSpent.omission, 0.004);
  assert.equal(budget.stageSpent.repair, 0);
  budget.finishOmissionAudit();
  (await budget.reserve(route, payload, 'candidateReview')).cancel();
  assert.equal(budget.targetUsd, 0.06);
});
