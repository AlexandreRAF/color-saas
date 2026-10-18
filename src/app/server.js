import Stripe from 'stripe';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { connectRedis } from './queue.js';
import { createApp } from './api.js';
import { log } from './errors.js';

const config = loadConfig();
const pool = createPool(config);
const redis = connectRedis(config);
const stripe = new Stripe(config.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 10000 });
const app = await createApp({ pool, redis, stripe, config });
const server = app.listen(config.PORT, () => log('api_started'));
server.requestTimeout = 30000;
server.headersTimeout = 10000;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10000);
  server.close(async () => { clearTimeout(timeout); redis.disconnect(); await pool.end(); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
