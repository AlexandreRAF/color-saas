import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { rows } from './db.js';
import { log } from './errors.js';

export const QUEUE = 'color-research';
export function connectRedis(config, worker = false) {
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: worker ? null : 1,
    connectTimeout: 3000, enableOfflineQueue: worker, retryStrategy: times => Math.min(times * 200, 3000) });
  redis.on('error', () => log('redis_error', { code: 'redis_unavailable' }));
  return redis;
}
export function createQueue(redis) {
  const queue = new Queue(QUEUE, { connection: redis });
  queue.on('error', () => log('queue_error', { code: 'queue_unavailable' }));
  return queue;
}

export async function dispatchJobs(pool, queue) {
  const jobs = await rows(pool, `SELECT j.id FROM jobs j JOIN research_outbox o ON o.job_id=j.id
    WHERE j.state IN ('queued','retry_wait') AND j.next_attempt_at<=UTC_TIMESTAMP(3)
    ORDER BY j.created_at LIMIT 100`);
  for (const { id } of jobs) {
    const old = await queue.getJob(id);
    if (old) {
      const state = await old.getState();
      if (['completed', 'failed'].includes(state)) await old.remove();
      else continue;
    }
    await queue.add('research', { id }, { jobId: id, attempts: 1,
      removeOnComplete: true, removeOnFail: { age: 3600, count: 1000 } });
    // If this write fails, the next scan safely finds the existing queue ID.
    await rows(pool, 'UPDATE research_outbox SET dispatched_at=UTC_TIMESTAMP(3) WHERE job_id=?', [id]);
  }
}
