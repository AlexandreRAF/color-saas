import { Worker } from 'bullmq';
import { loadConfig } from './config.js';
import { createPool, rows, json } from './db.js';
import { QUEUE, connectRedis, createQueue } from './queue.js';
import { acquireJob, finishAttempt } from './jobs.js';
import { runResearch } from './research-adapter.js';
import { log } from './errors.js';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

const config = loadConfig(process.env, 'worker');
for (const path of [config.LAZZUMIX_DATABASE_PATH, config.BASF_DATABASE_PATH, config.BASF_MODELS_DATABASE_PATH])
  await access(path, constants.R_OK).catch(() => { throw new Error(`Required read-only research catalog missing: ${path}`); });
if ((!process.env.OPENAI_API_KEY && !process.env.OPENROUTER_API_KEY) || !process.env.SERPER_API_KEY)
  throw new Error('Worker requires a model provider credential and SERPER_API_KEY');
const pool = createPool(config);
const redis = connectRedis(config, true);
const queue = createQueue(redis);
await redis.ping();
if (await queue.getGlobalConcurrency() !== config.AGENT_CONCURRENCY)
  throw new Error('Start the maintenance coordinator first; queue concurrency must match AGENT_CONCURRENCY');
const active = new Set();
const worker = new Worker(QUEUE, async entry => {
  const job = await acquireJob(pool, config, entry.data.id);
  if (!job) return;
  const controller = new AbortController();
  active.add(controller);
  let progress = { ...json(job.progress), stage: 'research', aiRunning: 0 };
  const previous = { ...progress };
  const cumulative = snapshot => ({ ...snapshot,
    pagesFetched: previous.pagesFetched + snapshot.pagesFetched,
    browserUses: previous.browserUses + snapshot.browserUses,
    aiCalls: previous.aiCalls + snapshot.aiCalls });
  let pending = false;
  const heartbeat = setInterval(async () => {
    if (pending) return;
    pending = true;
    try {
      const result = await rows(pool, `UPDATE jobs SET heartbeat_at=UTC_TIMESTAMP(3),progress=? WHERE id=?
        AND state='running' AND attempt_id=? AND execution_deadline>UTC_TIMESTAMP(3)`,
      [JSON.stringify(progress), job.id, job.attempt_id]);
      if (!result.affectedRows) controller.abort();
    } catch { controller.abort(); }
    finally { pending = false; }
  }, 2000);
  try {
    const outcome = await runResearch(job, { signal: controller.signal, catalogs: config,
      onProgress: snapshot => { progress = cumulative(snapshot); } });
    if (outcome.result?.progress) progress = { ...progress, ...cumulative(outcome.result.progress) };
    await rows(pool, "UPDATE jobs SET progress=? WHERE id=? AND attempt_id=? AND state='running'",
      [JSON.stringify(progress), job.id, job.attempt_id]);
    await finishAttempt(pool, config, job.id, job.attempt_id, outcome);
    log('research_finished', { jobId: job.id, attemptId: job.attempt_id, state: outcome.state });
  } finally { clearInterval(heartbeat); active.delete(controller); }
}, { connection: redis, concurrency: config.AGENT_CONCURRENCY, lockDuration: 30000, maxStalledCount: 1 });
worker.on('error', () => { for (const controller of active) controller.abort(); log('worker_error', { code: 'queue_connection_lost' }); });
worker.on('failed', job => log('worker_delivery_failed', { jobId: job?.data.id, code: 'delivery_failed' }));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => { for (const c of active) c.abort(); }, config.SHUTDOWN_GRACE_SECONDS * 1000);
  const hardStop = setTimeout(() => process.exit(1), (config.SHUTDOWN_GRACE_SECONDS + 5) * 1000);
  await worker.close();
  clearTimeout(timer); clearTimeout(hardStop);
  await queue.close(); await redis.quit(); await pool.end();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
