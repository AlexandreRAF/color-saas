import { randomUUID } from 'node:crypto';
import { rows, transaction } from './db.js';
import { decrypt } from './crypto.js';
import { log } from './errors.js';

export async function deliverEmail(pool, config, request = fetch) {
  for (let i = 0; i < 20; i++) {
    const message = await transaction(pool, async db => {
      const m = (await rows(db, `SELECT * FROM email_outbox WHERE delivered_at IS NULL AND failed_at IS NULL
        AND expires_at>UTC_TIMESTAMP(3) AND available_at<=UTC_TIMESTAMP(3)
        AND (lease_until IS NULL OR lease_until<UTC_TIMESTAMP(3)) ORDER BY available_at LIMIT 1 FOR UPDATE SKIP LOCKED`))[0];
      if (!m) return null;
      m.lease_token = randomUUID();
      await rows(db, 'UPDATE email_outbox SET lease_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 SECOND),lease_token=?,attempts=attempts+1 WHERE id=?', [m.lease_token, m.id]);
      return m;
    });
    if (!message) return;
    try {
      const payload = decrypt(message.payload, config.MAIL_ENCRYPTION_KEY);
      const response = await request(config.EMAIL_API_URL, { method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${config.EMAIL_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': message.id },
        body: JSON.stringify({ ...payload, from: config.EMAIL_FROM }) });
      await response.body?.cancel();
      if (!response.ok) throw new Error('delivery_failed');
      await rows(pool, 'UPDATE email_outbox SET delivered_at=UTC_TIMESTAMP(3),payload=NULL,lease_until=NULL WHERE id=? AND lease_token=?', [message.id, message.lease_token]);
    } catch {
      const exhausted = message.attempts + 1 >= config.MAIL_MAX_ATTEMPTS;
      await rows(pool, `UPDATE email_outbox SET failed_at=?,payload=IF(?,NULL,payload),available_at=?,
        lease_until=NULL,last_error='delivery_failed' WHERE id=? AND lease_token=?`,
      [exhausted ? new Date() : null, exhausted, new Date(Date.now() + 1000 * 2 ** (message.attempts + 1)), message.id, message.lease_token]);
      log(exhausted ? 'email_delivery_exhausted' : 'email_delivery_retry', { code: 'delivery_failed' });
    }
  }
}
