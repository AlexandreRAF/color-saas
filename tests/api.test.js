import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import Stripe from 'stripe';
import { createApp } from '../src/app/api.js';
import { config } from './helpers.js';

const stripe = new Stripe(config.STRIPE_SECRET_KEY);
const persisted = [];
let failPersistence = false;
const pool = { execute: async (sql, params) => {
  if (failPersistence) throw new Error('database unavailable');
  persisted.push({ sql, params });
  return [sql.startsWith('SELECT') ? [] : { affectedRows: 1 }];
} };
const redis = { eval: async () => 1, ping: async () => 'PONG' };
const app = await createApp({ pool, config, stripe, redis });

test('private endpoints require session and never cache research', async () => {
  const response = await request(app).get('/api/jobs');
  assert.equal(response.status, 401);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.ok(response.headers['content-security-policy'].includes("object-src 'none'"));
});
test('browser mutations reject cross-origin requests before reading data', async () => {
  await request(app).post('/api/auth/register').set('Origin', 'https://evil.test').send({}).expect(403);
  await request(app).post('/api/auth/register').set('Origin', config.PUBLIC_URL).send({}).expect(403);
  await request(app).post('/api/auth/register').set('Origin', config.PUBLIC_URL).set('X-Requested-With', 'Color').send({ extra: true }).expect(400);
});
test('webhook signature is checked on raw body, duplicate storage is idempotent, persistence failure returns error', async () => {
  const payload = JSON.stringify({ id: 'evt_test', type: 'checkout.session.completed', livemode: false,
    data: { object: { id: 'cs_test' } } });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: config.STRIPE_WEBHOOK_SECRET });
  await request(app).post('/api/stripe/webhook').set('Content-Type', 'application/json').send(payload).expect(400);
  for (let i = 0; i < 2; i++) await request(app).post('/api/stripe/webhook').set('Content-Type', 'application/json')
    .set('stripe-signature', signature).send(payload).expect(200);
  const event = persisted.find(p => p.sql.startsWith('INSERT IGNORE INTO stripe_events'));
  assert.deepEqual(event.params, ['evt_test', 'checkout.session.completed', 'cs_test']);
  assert.equal(event.params.includes(payload), false);
  failPersistence = true;
  await request(app).post('/api/stripe/webhook').set('Content-Type', 'application/json').set('stripe-signature', signature).send(payload).expect(500);
  failPersistence = false;
});
