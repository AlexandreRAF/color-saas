import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Worker } from 'bullmq';
import request from 'supertest';
import { config as defaults, input } from '../helpers.js';
import { createPool, rows } from '../../src/app/db.js';
import { submitJob, acquireJob, finishAttempt, cancelJob, ownedJob, recoverJobs } from '../../src/app/jobs.js';
import { fulfillPurchase, adjustPurchase, adjustmentTarget, processStripeEvents } from '../../src/app/payments.js';
import { connectRedis, createQueue, dispatchJobs, QUEUE } from '../../src/app/queue.js';
import { createApp } from '../../src/app/api.js';
import { getSession } from '../../src/app/auth.js';
import { digest, decrypt } from '../../src/app/crypto.js';
import { cleanup } from '../../src/app/privacy.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL);
const suite = enabled ? test : test.skip;
let pool, admin, config, redis, queue, database;
before(async () => {
  if (!enabled) return;
  // The test creates its own database. Never wipe a configured application DB.
  database = `color_test_${process.pid}_${Date.now()}`;
  config = { ...defaults, DATABASE_URL: process.env.TEST_DATABASE_URL, REDIS_URL: process.env.TEST_REDIS_URL,
    MAX_OUTSTANDING_JOBS_PER_USER: 100, RESEARCH_QUEUE_MAX_OUTSTANDING: 1000 };
  assert.equal(new URL(config.REDIS_URL).pathname, '/15', 'Integration Redis must be a dedicated instance, database 15');
  admin = createPool(config);
  await rows(admin, `CREATE DATABASE ${database}`);
  const url = new URL(config.DATABASE_URL); url.pathname = `/${database}`;
  config = { ...config, DATABASE_URL: url.href };
  pool = createPool(config);
  const schema = await readFile(new URL('../../migrations/001_initial.sql', import.meta.url), 'utf8');
  for (const statement of schema.split(';').map(s => s.trim()).filter(Boolean)) await rows(pool, statement);
  redis = connectRedis(config, true); await redis.ping();
  await redis.flushdb();
  queue = createQueue(redis); await queue.setGlobalConcurrency(config.AGENT_CONCURRENCY);
});
after(async () => {
  if (queue) await queue.close();
  if (redis) await redis.quit();
  if (pool) await pool.end();
  if (admin) { await rows(admin, `DROP DATABASE ${database}`); await admin.end(); }
});
async function user(balance = 3) {
  const id = randomUUID();
  await rows(pool, 'INSERT INTO users(id,email,password_hash,balance,verified_at) VALUES(?,?,?,?,UTC_TIMESTAMP(3))', [id, `${id}@test.example`, 'test', balance]);
  await rows(pool, "INSERT INTO ledger(user_id,kind,balance_delta,reserved_delta,reference) VALUES(?,'grant',?,0,?)", [id, balance, `test:${id}`]);
  return id;
}
async function account(id) { return (await rows(pool, 'SELECT * FROM users WHERE id=?', [id]))[0]; }
async function settleRemaining(id) {
  for (const job of await rows(pool, "SELECT * FROM jobs WHERE user_id=? AND state='queued'", [id])) await cancelJob(pool, config, id, job.id);
}

suite('parallel admission cannot spend the same credit or exceed queue limits', async () => {
  const id = await user(1);
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => submitJob(pool, config, id, input, randomUUID())));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await account(id)).reserved, 1);
  await settleRemaining(id);
  const capped = await user(10);
  const limited = { ...config, MAX_OUTSTANDING_JOBS_PER_USER: 2 };
  const jobs = await Promise.allSettled(Array.from({ length: 8 }, () => submitJob(pool, limited, capped, input, randomUUID())));
  assert.equal(jobs.filter(r => r.status === 'fulfilled').length, 2);
  await settleRemaining(capped);
});

suite('duplicate submissions share a durable job; payload mismatch fails without another reservation', async () => {
  const id = await user(), key = randomUUID();
  const jobs = await Promise.all(Array.from({ length: 10 }, () => submitJob(pool, config, id, input, key)));
  assert.equal(new Set(jobs).size, 1); assert.equal((await account(id)).reserved, 1);
  await assert.rejects(submitJob(pool, config, id, { ...input, model: 'Polo' }, key), { code: 'idempotency_conflict' });
  const [outbox] = await rows(pool, 'SELECT * FROM research_outbox WHERE job_id=?', [jobs[0]]);
  assert.ok(outbox);
  await settleRemaining(id);
});

suite('duplicate completion and superseded attempts cannot duplicate settlement or overwrite results', async () => {
  const id = await user(), jobId = await submitJob(pool, config, id, input, randomUUID());
  const job = await acquireJob(pool, config, jobId);
  assert.ok(job);
  assert.equal(await finishAttempt(pool, config, jobId, randomUUID(), { state: 'completed' }), false);
  const outcome = { state: 'completed', result: { colors: [{ name: 'Vermelho' }] }, knownCostMicroUsd: 3000, costComplete: true };
  await Promise.all(Array.from({ length: 8 }, () => finishAttempt(pool, config, jobId, job.attempt_id, outcome)));
  const a = await account(id); assert.equal(a.balance, 2); assert.equal(a.reserved, 0);
  assert.equal((await rows(pool, 'SELECT * FROM settlements WHERE job_id=?', [jobId])).length, 1);
  assert.equal(await acquireJob(pool, config, jobId), null);
});

suite('queued cancellation races atomically with acquisition', async () => {
  for (let i = 0; i < 4; i++) {
    const id = await user(), jobId = await submitJob(pool, config, id, input, randomUUID());
    const results = await Promise.allSettled([cancelJob(pool, config, id, jobId), acquireJob(pool, config, jobId)]);
    const job = (await rows(pool, 'SELECT * FROM jobs WHERE id=?', [jobId]))[0];
    if (job.state === 'running') {
      assert.equal(results[0].status, 'rejected');
      await finishAttempt(pool, config, jobId, job.attempt_id, { state: 'failed' });
    } else { assert.equal(job.state, 'cancelled'); assert.equal(results[1].value, null); }
    assert.equal((await account(id)).reserved, 0);
    assert.equal((await account(id)).balance, 3);
  }
});

suite('worker interruption is fenced until external deadline, then retry is safe and stale writes fail', async () => {
  await rows(pool, 'UPDATE app_control SET pause_until=NULL,provider_failures=0 WHERE id=1');
  const id = await user(), jobId = await submitJob(pool, config, id, input, randomUUID());
  const first = await acquireJob(pool, config, jobId);
  await recoverJobs(pool, config);
  assert.equal(await acquireJob(pool, config, jobId), null);
  await rows(pool, 'UPDATE jobs SET execution_deadline=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 20 SECOND) WHERE id=?', [jobId]);
  await recoverJobs(pool, config);
  const second = await acquireJob(pool, config, jobId);
  assert.notEqual(first.attempt_id, second.attempt_id);
  assert.equal(await finishAttempt(pool, config, jobId, first.attempt_id, { state: 'completed' }), false);
  await finishAttempt(pool, config, jobId, second.attempt_id, { state: 'partial', result: { colors: [] } });
  assert.equal((await account(id)).balance, 3);
  assert.equal((await account(id)).reserved, 0);
});

suite('Redis loss is reconciled from MySQL and global concurrency spans multiple workers', async () => {
  await rows(pool, 'UPDATE app_control SET pause_until=NULL,provider_failures=0 WHERE id=1');
  const id = await user(10);
  const jobs = await Promise.all(Array.from({ length: 8 }, () => submitJob(pool, config, id, input, randomUUID())));
  await dispatchJobs(pool, queue); await redis.flushdb();
  await queue.setGlobalConcurrency(2); await dispatchJobs(pool, queue);
  assert.ok(await queue.getJob(jobs[0]));
  let running = 0, peak = 0, completed = 0;
  const process = async entry => {
    running++; peak = Math.max(peak, running);
    try {
      const job = await acquireJob(pool, config, entry.data.id);
      await new Promise(resolve => setTimeout(resolve, 50));
      if (job) await finishAttempt(pool, config, job.id, job.attempt_id, { state: 'completed', result: { colors: [] } });
    } finally { running--; completed++; }
  };
  const workers = [new Worker(QUEUE, process, { connection: redis, concurrency: 4 }), new Worker(QUEUE, process, { connection: redis, concurrency: 4 })];
  try {
    const end = Date.now() + 10000;
    while (completed < jobs.length && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(completed, jobs.length); assert.equal(peak, 2);
  } finally { await Promise.all(workers.map(w => w.close())); await queue.setGlobalConcurrency(config.AGENT_CONCURRENCY); }
});

suite('history authorization and expiry apply before cleanup; idempotency keys survive deletion', async () => {
  const id = await user(), other = await user(), key = randomUUID();
  const jobId = await submitJob(pool, config, id, input, key);
  await assert.rejects(ownedJob(pool, other, jobId), { status: 404 });
  await cancelJob(pool, config, id, jobId);
  await rows(pool, 'UPDATE jobs SET history_expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?', [jobId]);
  await assert.rejects(ownedJob(pool, id, jobId), { status: 410 });
  await cleanup(pool, config);
  await assert.rejects(submitJob(pool, config, id, input, key), { status: 410 });
  assert.equal((await rows(pool, 'SELECT * FROM jobs WHERE id=?', [jobId])).length, 0);
});

suite('duplicate payments and overlapping adjustments preserve ledger and debt', async () => {
  const id = await user(0), purchase = randomUUID();
  await rows(pool, `INSERT INTO purchases(id,user_id,idempotency_key,pack_id,credits,amount,currency,price_id,created_at)
    VALUES(?,?,?,'small',10,1990,'brl','price_test',UTC_TIMESTAMP(3))`, [purchase, id, randomUUID()]);
  const session = { id: `cs_${purchase}`, metadata: { purchase_id: purchase }, payment_status: 'paid', status: 'complete',
    amount_total: 1990, currency: 'brl', payment_intent: `pi_${purchase}` };
  await Promise.all(Array.from({ length: 5 }, () => fulfillPurchase(pool, purchase, session)));
  assert.equal((await account(id)).balance, 10);
  // Spend a credit while a second reservation remains accepted during reversal.
  const jobId = await submitJob(pool, config, id, input, randomUUID());
  const accepted = await submitJob(pool, config, id, input, randomUUID());
  const job = await acquireJob(pool, config, jobId);
  await finishAttempt(pool, config, jobId, job.attempt_id, { state: 'completed', result: {} });
  await adjustPurchase(pool, purchase, adjustmentTarget(10, 0, 'needs_response'));
  await adjustPurchase(pool, purchase, adjustmentTarget(10, 10, 'lost'), true);
  await adjustPurchase(pool, purchase, adjustmentTarget(10, 10, 'lost'), true);
  assert.equal((await account(id)).balance, -1);
  await assert.rejects(submitJob(pool, config, id, input, randomUUID()), { status: 402 });
  const retained = await acquireJob(pool, config, accepted); assert.ok(retained);
  await finishAttempt(pool, config, accepted, retained.attempt_id, { state: 'partial', result: {} });
  assert.equal((await account(id)).reserved, 0);
  const [sum] = await rows(pool, 'SELECT SUM(balance_delta) AS total FROM ledger WHERE user_id=?', [id]);
  assert.equal(Number(sum.total), -1);
});

suite('authentication persists sessions, verifies codes once, revokes on reset and rejects CSRF', async () => {
  const app = await createApp({ pool, config, redis, stripe: {} });
  const email = `${randomUUID()}@test.example`, password = 'A-long-test-password!';
  const post = (path, body, cookie, csrf) => {
    const req = request(app).post(`/api${path}`).set('Origin', config.PUBLIC_URL).set('X-Requested-With', 'Color');
    if (cookie) req.set('Cookie', cookie);
    if (csrf) req.set('X-CSRF-Token', csrf);
    return req.send(body);
  };
  await post('/auth/register', { email, password }).expect(202);
  const u = (await rows(pool, 'SELECT * FROM users WHERE email=?', [email]))[0];
  const [message] = await rows(pool, 'SELECT * FROM email_outbox WHERE user_id=?', [u.id]);
  const code = decrypt(message.payload, config.MAIL_ENCRYPTION_KEY).text.match(/: (\d{6})/)[1];
  await assert.rejects(submitJob(pool, config, u.id, input, randomUUID()), { status: 403 });
  await post('/auth/verify', { email, code: '000000' }).expect(400);
  assert.equal((await rows(pool, 'SELECT attempts FROM challenges WHERE user_id=?', [u.id]))[0].attempts, 1);
  await post('/auth/verify', { email, code }).expect(200);
  await post('/auth/verify', { email, code }).expect(400);
  const login = await post('/auth/login', { email, password }).expect(200);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.match(login.headers['set-cookie'][0], /Secure/); assert.match(login.headers['set-cookie'][0], /HttpOnly/);
  await request(app).get('/api/me').set('Cookie', cookie).expect(200);
  const restarted = await createApp({ pool, config, redis, stripe: {} });
  await request(restarted).get('/api/me').set('Cookie', cookie).expect(200);
  await post('/jobs', input, cookie).expect(403);
  await post('/auth/forgot-password', { email }).expect(202);
  const resetMessages = await rows(pool, 'SELECT * FROM email_outbox WHERE user_id=? AND id<>?', [u.id, message.id]);
  const reset = decrypt(resetMessages[0].payload, config.MAIL_ENCRYPTION_KEY).text.split('\n')[0].split(': ')[1];
  await post('/auth/reset-password', { email, token: reset, password: 'Another-long-password!' }).expect(200);
  await request(app).get('/api/me').set('Cookie', cookie).expect(401);
  await post('/auth/reset-password', { email, token: reset, password }).expect(400);
  const next = await post('/auth/login', { email, password: 'Another-long-password!' }).expect(200);
  const raw = next.headers['set-cookie'][0].split(';')[0].split('=')[1];
  await rows(pool, 'UPDATE sessions SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE digest=?', [digest(raw, config.TOKEN_PEPPER)]);
  assert.equal(await getSession(pool, config, raw), null);
});

suite('reordered refund-before-checkout webhooks use current Stripe state and do not double grant', async () => {
  const id = await user(), purchase = randomUUID(), payment = `pi_${purchase}`, checkout = `cs_${purchase}`;
  await rows(pool, `INSERT INTO purchases(id,user_id,idempotency_key,pack_id,credits,amount,currency,price_id,session_id,created_at)
    VALUES(?,?,?,'small',10,1990,'brl','price_test',?,UTC_TIMESTAMP(3))`, [purchase, id, randomUUID(), checkout]);
  const session = { id: checkout, metadata: { purchase_id: purchase }, payment_status: 'paid', status: 'complete',
    amount_total: 1990, currency: 'brl', payment_intent: payment };
  const stripe = { checkout: { sessions: { retrieve: async () => session } },
    charges: { retrieve: async () => ({ payment_intent: payment }) },
    paymentIntents: { retrieve: async () => ({ metadata: { purchase_id: purchase } }) },
    refunds: { list: () => ({ autoPagingToArray: async () => [{ id: 're_full', status: 'succeeded', amount: 1990 }] }) },
    disputes: { list: () => ({ autoPagingToArray: async () => [] }) } };
  const first = randomUUID(), second = randomUUID();
  await rows(pool, "INSERT INTO stripe_events(id,type,object_id) VALUES(?,'charge.refunded','ch_test')", [first]);
  await processStripeEvents(pool, config, stripe);
  assert.equal((await account(id)).balance, 3);
  await rows(pool, "INSERT INTO stripe_events(id,type,object_id) VALUES(?,'checkout.session.completed',?)", [second, checkout]);
  await processStripeEvents(pool, config, stripe);
  await processStripeEvents(pool, config, stripe);
  assert.equal((await account(id)).balance, 3);
  const [p] = await rows(pool, 'SELECT * FROM purchases WHERE id=?', [purchase]);
  assert.equal(p.withheld_credits, 10);
  assert.equal((await rows(pool, "SELECT id FROM ledger WHERE user_id=? AND kind='purchase'", [id])).length, 1);
  assert.equal((await rows(pool, 'SELECT id FROM stripe_events WHERE id IN (?,?) AND processed_at IS NOT NULL', [first, second])).length, 2);
});

suite('queue expiry, execution timeout and admission pause release or preserve credits correctly', async () => {
  const id = await user();
  const queued = await submitJob(pool, config, id, input, randomUUID());
  await rows(pool, 'UPDATE jobs SET waiting_since=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 901 SECOND) WHERE id=?', [queued]);
  await recoverJobs(pool, config);
  assert.equal((await ownedJob(pool, id, queued)).state, 'expired');
  assert.equal((await account(id)).reserved, 0);
  const running = await submitJob(pool, config, id, input, randomUUID());
  const attempt = await acquireJob(pool, config, running);
  await rows(pool, 'UPDATE jobs SET execution_deadline=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?', [running]);
  await finishAttempt(pool, config, running, attempt.attempt_id, { state: 'completed', result: { colors: [] } });
  assert.equal((await ownedJob(pool, id, running)).state, 'failed');
  assert.equal((await account(id)).balance, 3);
  await rows(pool, 'UPDATE app_control SET paused=TRUE WHERE id=1');
  try { await assert.rejects(submitJob(pool, config, id, input, randomUUID()), { code: 'admission_paused' }); }
  finally { await rows(pool, 'UPDATE app_control SET paused=FALSE,pause_until=NULL,provider_failures=0 WHERE id=1'); }
  assert.equal((await account(id)).reserved, 0);
});

suite('SSE starts with the durable snapshot and closes after session revocation', async () => {
  const id = await user(), jobId = await submitJob(pool, config, id, input, randomUUID());
  const raw = 's'.repeat(43), csrf = 'test';
  await rows(pool, 'INSERT INTO sessions(digest,user_id,csrf_digest,created_at,expires_at) VALUES(?,?,?,UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 DAY))',
    [digest(raw, config.TOKEN_PEPPER), id, digest(csrf, config.TOKEN_PEPPER)]);
  const app = await createApp({ pool, config, redis, stripe: {} });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/jobs/${jobId}/events`,
      { headers: { Cookie: `__Host-color_session=${raw}` }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const reader = response.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: snapshot/); assert.ok(first.includes(jobId));
    await rows(pool, 'UPDATE sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE digest=?', [digest(raw, config.TOKEN_PEPPER)]);
    assert.equal((await reader.read()).done, true);
  } finally {
    controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await settleRemaining(id);
  }
});
