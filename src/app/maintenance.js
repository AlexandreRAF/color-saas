import Stripe from 'stripe';
import { loadConfig } from './config.js';
import { createPool, rows } from './db.js';
import { connectRedis, createQueue, dispatchJobs } from './queue.js';
import { recoverJobs } from './jobs.js';
import { cleanup } from './privacy.js';
import { deliverEmail } from './email.js';
import { processStripeEvents, reconcilePurchase } from './payments.js';
import { log } from './errors.js';

const config = loadConfig(process.env, 'maintenance');
const pool = createPool(config);
const redis = connectRedis(config);
const queue = createQueue(redis);
const stripe = new Stripe(config.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 10000 });
const coordinator = await pool.getConnection();
const [lock] = await rows(coordinator, "SELECT GET_LOCK('color-maintenance',0) AS acquired");
if (lock.acquired !== 1) throw new Error('Another maintenance coordinator is active');
// Loss of the MySQL connection also loses the coordinator lease. Exit before
// issuing any more queue settings or applying remotely fetched payment state.
coordinator.connection.on('error', () => process.exit(1));
let stopped = false, lastCleanup = 0;
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });
const tasks = [
  ['job_recovery', () => recoverJobs(pool, config)],
  ['queue_dispatch', async () => {
    await queue.setGlobalConcurrency(config.AGENT_CONCURRENCY);
    await dispatchJobs(pool, queue);
  }],
  ['email_delivery', () => deliverEmail(pool, config)],
  ['stripe_events', () => processStripeEvents(pool, config, stripe)],
  ['purchase_reconciliation', async () => {
    const purchases = await rows(pool, `SELECT * FROM purchases WHERE (reconciled_at IS NULL
      OR reconciled_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))
      AND state IN ('pending','fulfilled') ORDER BY COALESCE(reconciled_at,created_at) LIMIT 10`);
    for (const purchase of purchases) {
      try { await reconcilePurchase(pool, config, stripe, purchase); }
      catch (error) { log('purchase_reconciliation_failed', { code: error.code === 'refund_allocation_required' ? error.code : 'payment_unavailable' }); }
    }
  }],
  ['retention_cleanup', async () => {
    if (Date.now() - lastCleanup < 60000) return;
    await cleanup(pool, config);
    lastCleanup = Date.now();
    const [ledger] = await rows(pool, `SELECT COUNT(*) AS count FROM users u LEFT JOIN
      (SELECT user_id,SUM(balance_delta) AS balance,SUM(reserved_delta) AS reserved FROM ledger GROUP BY user_id) l ON l.user_id=u.id
      WHERE u.balance<>COALESCE(l.balance,0) OR u.reserved<>COALESCE(l.reserved,0)`);
    const [reservations] = await rows(pool, `SELECT COUNT(*) AS count FROM users u WHERE u.reserved<>
      (SELECT COUNT(*) FROM jobs j WHERE j.user_id=u.id AND j.state IN ('queued','running','retry_wait'))`);
    if (ledger.count || reservations.count) {
      await rows(pool, 'UPDATE app_control SET paused=TRUE WHERE id=1');
      log('ledger_reconciliation_failed', { count: ledger.count + reservations.count });
    }
  }],
];
while (!stopped) {
  await rows(coordinator, 'SELECT 1');
  for (const [name, run] of tasks) {
    if (stopped) break;
    try { await run(); } catch { log('maintenance_failed', { code: name }); }
  }
  if (!stopped) await new Promise(resolve => setTimeout(resolve, 2000));
}
await queue.close(); redis.disconnect(); coordinator.release(); await pool.end();
