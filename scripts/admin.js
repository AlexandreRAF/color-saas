import { loadConfig } from '../src/app/config.js';
import { createPool, rows, transaction, lockControl } from '../src/app/db.js';
import { z } from 'zod';
import { parse, idSchema } from '../src/app/validation.js';

const [command, ...args] = process.argv.slice(2);
const config = loadConfig(process.env, 'migration');
const pool = createPool(config);
try {
  if (command === 'pause' || command === 'resume') {
    await transaction(pool, async db => {
      await lockControl(db);
      await rows(db, 'UPDATE app_control SET paused=?,pause_until=NULL,provider_failures=0 WHERE id=1', [command === 'pause']);
    });
    console.log(command === 'pause' ? 'Research admission paused; active attempts drain.' : 'Research admission resumed.');
  } else if (command === 'refund-allocation') {
    const [refund, purchase, quantity, operator] = args;
    parse(z.string().regex(/^re_[A-Za-z0-9]+$/), refund);
    parse(idSchema, purchase);
    const credits = parse(z.coerce.number().int().min(0).max(100000), quantity);
    parse(z.string().min(1).max(100), operator);
    await transaction(pool, async db => {
      const [p] = await rows(db, 'SELECT credits FROM purchases WHERE id=? FOR UPDATE', [purchase]);
      if (!p || credits > p.credits) throw new Error('Credit quantity exceeds the purchased pack');
      // Immutable operator decision; corrections require a reviewed compensating adjustment.
      await rows(db, 'INSERT INTO refund_allocations(refund_id,purchase_id,credits,recorded_by) VALUES(?,?,?,?)',
        [refund, purchase, credits, operator]);
      await rows(db, 'UPDATE purchases SET reconciled_at=NULL WHERE id=?', [purchase]);
      await rows(db, 'UPDATE stripe_events SET available_at=UTC_TIMESTAMP(3) WHERE object_id=? AND processed_at IS NULL', [refund]);
    });
    console.log('Refund credit allocation recorded; reconciliation will apply it.');
  } else if (command === 'status') {
    const [control] = await rows(pool, 'SELECT * FROM app_control WHERE id=1');
    const jobs = await rows(pool, 'SELECT state,COUNT(*) AS count FROM jobs GROUP BY state');
    const [email] = await rows(pool, 'SELECT COUNT(*) AS count FROM email_outbox WHERE failed_at IS NOT NULL');
    const [webhooks] = await rows(pool, 'SELECT COUNT(*) AS count FROM stripe_events WHERE processed_at IS NULL');
    const [stale] = await rows(pool, "SELECT COUNT(*) AS count FROM jobs WHERE state='running' AND heartbeat_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 SECOND)");
    console.log(JSON.stringify({ control, jobs, failedEmail: email.count, pendingWebhooks: webhooks.count, staleHeartbeats: stale.count }));
  } else throw new Error('Usage: admin.js pause | resume | status | refund-allocation REFUND_ID PURCHASE_ID CREDITS OPERATOR');
} finally { await pool.end(); }
