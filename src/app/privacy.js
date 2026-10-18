import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rows, transaction, lockControl } from './db.js';
import { parse } from './validation.js';
import { SESSION_COOKIE } from './auth.js';

export function installPrivacy(app, { pool, auth, rate }) {
  app.get('/api/account/export', auth, rate('export', 5, 3600), async (req, res) => {
    const account = await rows(pool, 'SELECT email,verified_at,created_at,balance,reserved FROM users WHERE id=?', [req.user.id]);
    const jobs = await rows(pool, `SELECT input,state,result,created_at,ended_at,history_expires_at FROM jobs WHERE user_id=?
      AND (history_expires_at IS NULL OR history_expires_at>UTC_TIMESTAMP(3))`, [req.user.id]);
    const ledger = await rows(pool, 'SELECT kind,balance_delta,reserved_delta,created_at FROM ledger WHERE user_id=?', [req.user.id]);
    const purchases = await rows(pool, 'SELECT credits,amount,currency,state,created_at,withheld_credits FROM purchases WHERE user_id=?', [req.user.id]);
    res.attachment('meus-dados-color.json').json({ account: account[0], jobs, ledger, purchases });
  });
  app.post('/api/account/privacy-requests', auth, rate('privacy', 5, 86400), async (req, res) => {
    const input = parse(z.strictObject({ kind: z.enum(['deletion', 'correction']), details: z.string().trim().max(500).optional() }), req.body);
    await transaction(pool, async db => {
      await lockControl(db);
      await rows(db, 'SELECT id FROM users WHERE id=? FOR UPDATE', [req.user.id]);
      await rows(db, 'INSERT INTO privacy_requests(id,user_id,kind,details,created_at) VALUES(?,?,?,?,UTC_TIMESTAMP(3))',
        [randomUUID(), req.user.id, input.kind, input.details || null]);
      if (input.kind === 'deletion') {
        await rows(db, 'UPDATE users SET deletion_requested_at=UTC_TIMESTAMP(3) WHERE id=?', [req.user.id]);
        await rows(db, 'UPDATE sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE user_id=?', [req.user.id]);
      }
    });
    if (input.kind === 'deletion') res.clearCookie(SESSION_COOKIE, { secure: true, httpOnly: true, sameSite: 'lax', path: '/' });
    res.status(202).json({ message: input.kind === 'deletion'
      ? 'Solicitação registrada. O acesso foi encerrado; pesquisas aceitas serão concluídas antes da exclusão. Registros financeiros sujeitos a retenção serão preservados.'
      : 'Solicitação de correção registrada para análise.' });
  });
}

export async function cleanup(pool, config) {
  // No anonymous copy is retained: deleting input, output, attempts, original job
  // IDs and progress avoids hidden re-identification links through free text.
  await rows(pool, 'DELETE FROM jobs WHERE history_expires_at<=UTC_TIMESTAMP(3)');
  await rows(pool, 'DELETE FROM sessions WHERE expires_at<=UTC_TIMESTAMP(3) OR revoked_at IS NOT NULL');
  await rows(pool, 'DELETE FROM challenges WHERE expires_at<=UTC_TIMESTAMP(3) OR used_at IS NOT NULL');
  await rows(pool, `UPDATE email_outbox SET payload=NULL,failed_at=COALESCE(failed_at,UTC_TIMESTAMP(3))
    WHERE expires_at<=UTC_TIMESTAMP(3) AND delivered_at IS NULL`);
  await rows(pool, `DELETE FROM email_outbox WHERE COALESCE(delivered_at,failed_at)<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ? DAY)`, [config.OPERATIONAL_RETENTION_DAYS]);
  await rows(pool, 'DELETE FROM stripe_events WHERE processed_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ? DAY)', [config.OPERATIONAL_RETENTION_DAYS]);
  const deleted = await rows(pool, `SELECT u.id FROM users u WHERE deletion_requested_at IS NOT NULL AND deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.user_id=u.id AND j.state IN ('queued','running','retry_wait')) LIMIT 100`);
  for (const user of deleted) {
    await transaction(pool, async db => {
      await lockControl(db);
      await rows(db, 'SELECT id FROM users WHERE id=? FOR UPDATE', [user.id]);
      const [active] = await rows(db, "SELECT COUNT(*) AS count FROM jobs WHERE user_id=? AND state IN ('queued','running','retry_wait')", [user.id]);
      if (active.count) return;
      await rows(db, 'DELETE FROM jobs WHERE user_id=?', [user.id]);
      await rows(db, 'DELETE FROM job_keys WHERE user_id=?', [user.id]);
      await rows(db, 'DELETE FROM sessions WHERE user_id=?', [user.id]);
      await rows(db, 'DELETE FROM challenges WHERE user_id=?', [user.id]);
      await rows(db, 'DELETE FROM email_outbox WHERE user_id=?', [user.id]);
      await rows(db, 'UPDATE users SET email=?,password_hash=?,deleted_at=UTC_TIMESTAMP(3) WHERE id=?',
        [`deleted-${user.id}@invalid.local`, 'disabled', user.id]);
      await rows(db, "UPDATE privacy_requests SET state='completed',details=NULL,completed_at=UTC_TIMESTAMP(3) WHERE user_id=? AND kind='deletion'", [user.id]);
    });
  }
  // Financial records have their own schedule; do not erase unpaid/review items.
  const expired = await rows(pool, `SELECT u.id FROM users u WHERE deleted_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ? DAY)
    AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.user_id=u.id AND (p.state IN ('pending','review')
      OR p.created_at>=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ? DAY)))
    AND NOT EXISTS (SELECT 1 FROM ledger l WHERE l.user_id=u.id AND l.created_at>=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ? DAY)) LIMIT 100`,
  [Math.max(config.FINANCIAL_RETENTION_DAYS, config.DELETION_AUDIT_RETENTION_DAYS), config.FINANCIAL_RETENTION_DAYS, config.FINANCIAL_RETENTION_DAYS]);
  for (const user of expired) {
    await transaction(pool, async db => {
      await lockControl(db);
      await rows(db, 'DELETE r FROM refund_allocations r JOIN purchases p ON p.id=r.purchase_id WHERE p.user_id=?', [user.id]);
      await rows(db, 'DELETE FROM purchases WHERE user_id=?', [user.id]);
      await rows(db, 'DELETE FROM ledger WHERE user_id=?', [user.id]);
      await rows(db, 'DELETE FROM privacy_requests WHERE user_id=?', [user.id]);
      await rows(db, 'DELETE FROM users WHERE id=?', [user.id]);
    });
  }
}
