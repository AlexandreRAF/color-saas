import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rows, transaction, lockControl } from './db.js';
import { demand } from './errors.js';
import { parse, keySchema } from './validation.js';

export async function ensureCheckout(pool, config, stripe, purchase) {
  if (purchase.session_id) return purchase.checkout_url;
  // Stripe forgets idempotency keys after at least 24 hours. Never recreate an
  // uncertain old session; its webhook or an operator must resolve it instead.
  demand(Date.now() - new Date(purchase.created_at).getTime() < 23 * 3600000,
    409, 'checkout_review', 'Esta compra precisa de conciliação. Inicie uma nova compra.');
  const price = await stripe.prices.retrieve(purchase.price_id);
  demand(price.active && price.unit_amount === purchase.amount && price.currency === purchase.currency && !price.recurring,
    503, 'price_mismatch', 'Este pacote está temporariamente indisponível.');
  const session = await stripe.checkout.sessions.create({ mode: 'payment', locale: 'pt-BR',
    line_items: [{ price: purchase.price_id, quantity: 1 }],
    client_reference_id: purchase.id, metadata: { purchase_id: purchase.id },
    payment_intent_data: { metadata: { purchase_id: purchase.id } },
    success_url: `${config.PUBLIC_URL}/app/#purchases`, cancel_url: `${config.PUBLIC_URL}/app/#purchases`,
  }, { idempotencyKey: `checkout:${purchase.id}` });
  await rows(pool, 'UPDATE purchases SET session_id=?,checkout_url=? WHERE id=? AND session_id IS NULL',
    [session.id, session.url, purchase.id]);
  return session.url;
}

export function installPayments(app, { pool, config, stripe, auth, rate }) {
  app.get('/api/packs', auth, (req, res) => res.json(config.packs.map(({ price, ...pack }) => pack)));
  app.post('/api/purchases', auth, rate('purchase', 10, 600), async (req, res) => {
    const { packId } = parse(z.strictObject({ packId: z.enum(['small', 'large']) }), req.body);
    const key = parse(keySchema, req.get('Idempotency-Key'));
    const purchase = await transaction(pool, async db => {
      const user = (await rows(db, 'SELECT * FROM users WHERE id=? FOR UPDATE', [req.user.id]))[0];
      demand(user.verified_at && !user.deletion_requested_at && !user.deleted_at, 403, 'verification_required', 'Confirme seu e-mail antes de comprar.');
      const old = (await rows(db, 'SELECT * FROM purchases WHERE user_id=? AND idempotency_key=?', [user.id, key]))[0];
      if (old) {
        demand(old.pack_id === packId, 409, 'idempotency_conflict', 'Esta chave já foi usada para outro pacote.');
        return old;
      }
      const pack = config.packs.find(p => p.id === packId);
      const id = randomUUID();
      await rows(db, `INSERT INTO purchases(id,user_id,idempotency_key,pack_id,credits,amount,currency,price_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [id, user.id, key, pack.id, pack.credits, pack.amount, pack.currency, pack.price]);
      return (await rows(db, 'SELECT * FROM purchases WHERE id=?', [id]))[0];
    });
    res.status(201).json({ id: purchase.id, url: await ensureCheckout(pool, config, stripe, purchase) });
  });
  app.get('/api/purchases', auth, async (req, res) => {
    const found = await rows(pool, `SELECT id,pack_id,credits,amount,currency,state,refunded_credits,disputed_credits,
      withheld_credits,created_at FROM purchases WHERE user_id=? ORDER BY created_at DESC LIMIT 100`, [req.user.id]);
    res.json(found);
  });
  app.get('/api/credits', auth, async (req, res) => res.json(await rows(pool,
    'SELECT kind,balance_delta,reserved_delta,created_at FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 100', [req.user.id])));
}

export async function acceptWebhook(pool, config, stripe, body, signature) {
  let event;
  try { event = stripe.webhooks.constructEvent(body, signature, config.STRIPE_WEBHOOK_SECRET); }
  catch { demand(false, 400, 'invalid_signature', 'Assinatura inválida.'); }
  demand(event.livemode === (config.STRIPE_MODE === 'live'), 400, 'stripe_mode_mismatch', 'Modo de pagamento inválido.');
  const supported = /^(checkout\.session\.(completed|async_payment_succeeded|async_payment_failed|expired)|charge\.(refunded|dispute\.(created|updated|closed|funds_withdrawn|funds_reinstated))|refund\.(created|updated|failed))$/;
  if (!supported.test(event.type)) return;
  await rows(pool, 'INSERT IGNORE INTO stripe_events(id,type,object_id) VALUES(?,?,?)',
    [event.id, event.type, event.data.object.id]);
}

export function adjustmentTarget(credits, refunded, disputeStatus) {
  const disputed = disputeStatus && !['won', 'warning_closed'].includes(disputeStatus) ? credits : 0;
  return { refunded, disputed, withheld: Math.min(credits, Math.max(refunded, disputed)) };
}

export async function fulfillPurchase(pool, purchaseId, session, adjustment = null, lost = false) {
  return transaction(pool, async db => {
    await lockControl(db);
    const p = (await rows(db, 'SELECT * FROM purchases WHERE id=? FOR UPDATE', [purchaseId]))[0];
    demand(p, 404, 'purchase_missing', 'Compra não encontrada.');
    demand((!p.session_id || p.session_id === session.id) && session.metadata?.purchase_id === p.id
      && session.amount_total === p.amount && session.currency === p.currency,
    409, 'payment_mismatch', 'O pagamento precisa de conciliação.');
    if (session.payment_status !== 'paid' || session.status !== 'complete') return;
    demand(session.payment_intent, 409, 'payment_missing', 'Pagamento ainda não confirmado.');
    if (!p.fulfilled_at) {
      await rows(db, 'SELECT id FROM users WHERE id=? FOR UPDATE', [p.user_id]);
      await rows(db, `INSERT INTO ledger(user_id,kind,balance_delta,reserved_delta,reference) VALUES(?,'purchase',?,0,?)`,
        [p.user_id, p.credits, `purchase:${p.id}`]);
      await rows(db, 'UPDATE users SET balance=balance+? WHERE id=?', [p.credits, p.user_id]);
      await rows(db, `UPDATE purchases SET state='fulfilled',session_id=?,payment_id=?,fulfilled_at=UTC_TIMESTAMP(3) WHERE id=?`,
        [session.id, typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id, p.id]);
    }
    // A refund arriving before fulfillment must never expose spendable credits
    // between the purchase grant and its already-known payment adjustment.
    if (adjustment) await adjustLocked(db, purchaseId, adjustment, lost);
  });
}

export async function adjustPurchase(pool, purchaseId, target, lost = false) {
  await transaction(pool, async db => {
    await lockControl(db);
    await adjustLocked(db, purchaseId, target, lost);
  });
}

async function adjustLocked(db, purchaseId, target, lost) {
  const p = (await rows(db, 'SELECT * FROM purchases WHERE id=? FOR UPDATE', [purchaseId]))[0];
  if (!p?.fulfilled_at) return;
  demand(Number.isInteger(target.refunded) && target.refunded >= p.refunded_credits && target.refunded <= p.credits
    && Number.isInteger(target.disputed) && target.disputed >= 0 && target.disputed <= p.credits
    && target.withheld === Math.max(target.refunded, target.disputed), 409, 'invalid_adjustment', 'Ajuste inválido.');
  const delta = p.withheld_credits - target.withheld;
  const version = p.adjustment_version + 1;
  if (delta !== 0 || (lost && p.disputed_credits > 0 && target.refunded > p.refunded_credits)) {
    await rows(db, 'SELECT id FROM users WHERE id=? FOR UPDATE', [p.user_id]);
    const kind = delta > 0 ? 'dispute_restore' : target.refunded > p.refunded_credits || lost ? 'reversal' : 'dispute_hold';
    await rows(db, `INSERT INTO ledger(user_id,kind,balance_delta,reserved_delta,reference) VALUES(?,?,?,0,?)`,
      [p.user_id, kind, delta, `adjust:${p.id}:${version}`]);
    await rows(db, 'UPDATE users SET balance=balance+? WHERE id=?', [delta, p.user_id]);
  }
  await rows(db, `UPDATE purchases SET refunded_credits=?,disputed_credits=?,withheld_credits=?,adjustment_version=? WHERE id=?`,
    [target.refunded, target.disputed, target.withheld, version, p.id]);
}

// One maintenance coordinator serializes remote snapshots. Never apply event order
// as payment truth: even a refund event first retrieves current Checkout state.
export async function reconcilePurchase(pool, config, stripe, purchase) {
  if (!purchase.session_id) {
    if (Date.now() - purchase.created_at.getTime() >= 23 * 3600000) {
      await rows(pool, "UPDATE purchases SET state='review',reconciled_at=UTC_TIMESTAMP(3) WHERE id=?", [purchase.id]);
      return;
    }
    await ensureCheckout(pool, config, stripe, purchase);
    purchase = (await rows(pool, 'SELECT * FROM purchases WHERE id=?', [purchase.id]))[0];
  }
  const session = await stripe.checkout.sessions.retrieve(purchase.session_id);
  if (session.status === 'expired') await rows(pool, "UPDATE purchases SET state='expired' WHERE id=? AND fulfilled_at IS NULL", [purchase.id]);
  if (session.payment_status === 'paid') {
    const paymentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id;
    const refunds = await stripe.refunds.list({ payment_intent: paymentId, limit: 100 }).autoPagingToArray({ limit: 1000 });
    const disputes = await stripe.disputes.list({ payment_intent: paymentId, limit: 100 }).autoPagingToArray({ limit: 1000 });
    const successful = refunds.filter(r => r.status === 'succeeded');
    let refunded = 0;
    if (successful.reduce((sum, r) => sum + r.amount, 0) >= purchase.amount) refunded = purchase.credits;
    else {
      for (const refund of successful) {
        const allocation = (await rows(pool, 'SELECT credits FROM refund_allocations WHERE refund_id=? AND purchase_id=?', [refund.id, purchase.id]))[0];
        demand(allocation, 409, 'refund_allocation_required', 'Reembolso parcial precisa de uma quantidade de créditos registrada.');
        refunded += allocation.credits;
      }
    }
    const lost = disputes.some(d => d.status === 'lost');
    const active = disputes.find(d => !['won', 'warning_closed'].includes(d.status));
    if (lost) refunded = purchase.credits;
    const current = (await rows(pool, 'SELECT refunded_credits FROM purchases WHERE id=?', [purchase.id]))[0];
    refunded = Math.max(refunded, current.refunded_credits);
    await fulfillPurchase(pool, purchase.id, session, adjustmentTarget(purchase.credits, refunded, active?.status), lost);
  } else await fulfillPurchase(pool, purchase.id, session);
  await rows(pool, 'UPDATE purchases SET reconciled_at=UTC_TIMESTAMP(3) WHERE id=?', [purchase.id]);
}

export async function processStripeEvents(pool, config, stripe) {
  const events = await rows(pool, `SELECT * FROM stripe_events WHERE processed_at IS NULL AND available_at<=UTC_TIMESTAMP(3)
    ORDER BY created_at LIMIT 30`);
  for (const event of events) {
    try {
      let purchase;
      if (event.type.startsWith('checkout.session.')) {
        const session = await stripe.checkout.sessions.retrieve(event.object_id);
        purchase = (await rows(pool, 'SELECT * FROM purchases WHERE id=?', [session.metadata?.purchase_id || '']))[0];
        if (purchase && !purchase.session_id) {
          await rows(pool, 'UPDATE purchases SET session_id=? WHERE id=? AND session_id IS NULL', [session.id, purchase.id]);
          purchase.session_id = session.id;
        }
      } else {
        const object = event.type.startsWith('charge.dispute.') ? await stripe.disputes.retrieve(event.object_id)
          : event.type.startsWith('refund.') ? await stripe.refunds.retrieve(event.object_id)
            : await stripe.charges.retrieve(event.object_id);
        const paymentId = typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id;
        purchase = (await rows(pool, 'SELECT * FROM purchases WHERE payment_id=?', [paymentId || '']))[0];
        if (!purchase && paymentId) {
          const intent = await stripe.paymentIntents.retrieve(paymentId);
          purchase = (await rows(pool, 'SELECT * FROM purchases WHERE id=?', [intent.metadata?.purchase_id || '']))[0];
        }
      }
      demand(purchase, 409, 'purchase_missing', 'Compra não encontrada.');
      await reconcilePurchase(pool, config, stripe, purchase);
      await rows(pool, 'UPDATE stripe_events SET processed_at=UTC_TIMESTAMP(3),last_error=NULL WHERE id=?', [event.id]);
    } catch (error) {
      await rows(pool, `UPDATE stripe_events SET attempts=attempts+1,last_error=?,available_at=? WHERE id=?`,
        [error.code === 'refund_allocation_required' ? error.code : 'reconciliation_failed',
          new Date(Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(event.attempts, 12))), event.id]);
    }
  }
}
