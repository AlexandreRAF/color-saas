import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runResearch } from '../src/app/research-adapter.js';

async function running(pid) {
  try { return !(await readFile(`/proc/${pid}/stat`, 'utf8')).includes(') Z '); }
  catch (e) { if (['ENOENT', 'ESRCH'].includes(e.code)) return false; throw e; }
}
test('external deadline stops real subprocess descendants and strips application credentials', async () => {
  let progress;
  const started = Date.now();
  const outcome = await runResearch({ input: {}, execution_deadline: new Date(Date.now() + 1000),
    run_config: { runCapMicroUsd: 200000, maxAttempts: 2, searchMicroUsd: 1000 } },
  { childScript: fileURLToPath(new URL('./fixtures/hanging-researcher.js', import.meta.url)),
    env: { ...process.env, DATABASE_URL: 'must-not-reach-research', STRIPE_SECRET_KEY: 'must-not-reach-research' },
    onProgress: value => { progress = value; } });
  assert.equal(outcome.state, 'failed'); assert.equal(outcome.code, 'execution_timeout');
  assert.ok(Date.now() - started < 4000);
  assert.ok(progress?.pid); assert.equal(progress.hasDatabaseCredential, false); assert.equal(progress.hasStripeCredential, false);
  assert.equal(await running(progress.pid), false);
  assert.equal(await running(progress.descendant), false);
});
