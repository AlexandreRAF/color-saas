import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/app/config.js';
import { testEnv, input } from './helpers.js';
import { parse, vehicle, safeUrl } from '../src/app/validation.js';
import { classifyResult, updateProgress } from '../src/app/research-adapter.js';
import { adjustmentTarget } from '../src/app/payments.js';
import { availableCredits, waitingMs } from '../src/app/jobs.js';
import { digest, encrypt, decrypt, equal } from '../src/app/crypto.js';
import { budgetedFetch } from '../src/app/provider-budget.js';

test('configuration defaults and related limits are validated', () => {
  assert.equal(loadConfig(testEnv).AGENT_CONCURRENCY, 4);
  assert.equal(loadConfig(testEnv).SESSION_TTL_DAYS, 14);
  assert.equal(loadConfig(testEnv).HISTORY_RETENTION_DAYS, 7);
  for (const patch of [{ AGENT_CONCURRENCY: '0' }, { AGENT_CONCURRENCY: '1.2' },
    { SHUTDOWN_GRACE_SECONDS: '120' }, { RESEARCH_RUN_CAP_MICRO_USD: undefined },
    { PUBLIC_URL: 'http://localhost' }, { STRIPE_MODE: 'live' }, { NODE_ENV: 'production' },
    { DEPLOYMENT_DAILY_CAP_MICRO_USD: '100' }]) assert.throws(() => loadConfig({ ...testEnv, ...patch }));
});

test('vehicle schema rejects extra fields, coercion and oversized input', () => {
  assert.deepEqual(parse(vehicle, input), input);
  for (const patch of [{ userId: 'attacker' }, { model: 'x'.repeat(101) }, { manufacturingYear: '2015' },
    { manufacturingYear: 1800 }, { model: '' }, { model: 'a\nb' }]) assert.throws(() => parse(vehicle, { ...input, ...patch }));
});

test('empty, unknown and outage results never turn into billable successes', () => {
  for (const value of [null, {}, { colors: [] }, { colors: [], error: 'provider outage' },
    { completion: { status: 'complete', issues: [] }, colors: [] }]) assert.equal(classifyResult(value).state, 'failed');
  assert.equal(classifyResult({ colors: [], completion: { status: 'partial', issues: ['no_colors'] } }).state, 'partial');
  assert.equal(classifyResult({ colors: [], completion: { status: 'no_colors_found' },
    research: { status: 'complete', discoveryCoverage: { needsExpansion: false } } }).state, 'no_colors_found');
});

test('complete results require usable sources and retain uncertainty without source-count ranking', () => {
  const raw = { completion: { status: 'complete', issues: [] }, colors: [
    { name: 'A', confidence: 'low', sources: ['https://a.test', 'https://b.test'], verification: { unknown: ['year'] } },
    { name: 'B', confidence: 'high', sources: ['https://c.test'] },
  ] };
  const outcome = classifyResult(raw);
  assert.equal(outcome.state, 'completed');
  assert.equal(outcome.result.colors[0].name, 'B');
  assert.deepEqual(outcome.result.colors[1].uncertainty.unknown, ['year']);
  raw.colors[0].sources = ['javascript:alert(1)'];
  assert.equal(classifyResult(raw).state, 'partial');
  assert.equal(safeUrl('data:text/html,<script>'), null);
  assert.equal(safeUrl('https://user:password@example.com'), null);
});

test('progress distinguishes cumulative calls and simultaneous work', () => {
  let p = { stage: 'research', pagesFetched: 0, browserUses: 0, aiCalls: 0, aiRunning: 0 };
  for (const event of [{ event: 'model_route_start' }, { event: 'model_route_start' }, { event: 'model_route_complete' },
    { event: 'page_fetch_complete', status: 'error' }, { event: 'page_fetch_complete', status: 'ok' }]) p = updateProgress(p, event);
  assert.equal(p.aiCalls, 2); assert.equal(p.aiRunning, 1); assert.equal(p.pagesFetched, 1);
});

test('reservations and debt cannot be spent, waiting is cumulative', () => {
  assert.equal(availableCredits({ balance: 3, reserved: 3 }), 0);
  assert.equal(availableCredits({ balance: -3, reserved: 1 }), 0);
  assert.equal(waitingMs({ waited_ms: 3000, waiting_since: new Date(5000) }, 7000), 5000);
});

test('refund and dispute overlap cannot reverse a pack twice', () => {
  assert.deepEqual(adjustmentTarget(10, 3, 'needs_response'), { refunded: 3, disputed: 10, withheld: 10 });
  assert.equal(adjustmentTarget(10, 10, 'lost').withheld, 10);
  assert.equal(adjustmentTarget(10, 3, 'won').withheld, 3);
  assert.equal(adjustmentTarget(10, 0, 'won').withheld, 0);
});

test('mail secrets are authenticated encrypted and digests are scoped', () => {
  const key = 'a'.repeat(64), secret = { to: 'test@example.com', text: '123456' };
  const sealed = encrypt(secret, key);
  assert.deepEqual(decrypt(sealed, key), secret);
  assert.throws(() => decrypt(sealed, 'b'.repeat(64)));
  assert.notEqual(digest('verify:user:123456', key), digest('reset:user:123456', key));
  assert.equal(equal('same', 'same'), true); assert.equal(equal('short', 'longer'), false);
});

test('provider spending gate reserves every actual attempt and bounds model output', async () => {
  const requests = [];
  const request = budgetedFetch(async (url, init) => { requests.push(JSON.parse(init.body)); return { ok: true }; },
    { capMicroUsd: 10000, prices: { 'openai:model:default': { input: 1, output: 1 } } });
  await request('https://api.openai.com/v1/responses', { body: JSON.stringify({ model: 'model', input: 'hello' }) });
  assert.equal(requests[0].max_output_tokens, 4096);
  await assert.rejects(request('https://api.openai.com/v1/responses', { body: JSON.stringify({ model: 'model', input: 'hello' }) }), { code: 'AI_BUDGET_LIMIT' });
  await assert.rejects(request('https://api.openai.com/v1/responses', { body: JSON.stringify({ model: 'unknown' }) }), { code: 'AI_BUDGET_LIMIT' });
  await assert.rejects(request('https://evil.test', { headers: { Authorization: 'secret' } }), { code: 'PROVIDER_BLOCKED' });
  assert.equal(requests.length, 1);
});
