import express from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { rows } from './db.js';
import { demand, log } from './errors.js';
import { rateLimiter } from './rate-limit.js';
import { authMiddleware, installAuth, installAccount } from './auth.js';
import { installJobs } from './jobs.js';
import { installPayments, acceptWebhook } from './payments.js';
import { installPrivacy } from './privacy.js';
import { installMetrics } from './metrics.js';

export async function createApp({ pool, redis, stripe, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  const counters = { requests: 0, errors: 0, durationMs: 0 };
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"],
    styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
    objectSrc: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"], upgradeInsecureRequests: [] } } }));
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set('X-Request-Id', req.requestId);
    const start = Date.now();
    res.on('finish', () => {
      counters.requests++; counters.durationMs += Date.now() - start;
      if (res.statusCode >= 500) counters.errors++;
      log('http_request', { requestId: req.requestId, durationMs: Date.now() - start, code: String(res.statusCode) });
    });
    next();
  });
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  app.get('/health/live', (req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (req, res) => {
    try { await rows(pool, 'SELECT id FROM app_control WHERE id=1'); await redis.ping(); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    await acceptWebhook(pool, config, stripe, req.body, req.get('stripe-signature'));
    res.status(200).json({ received: true });
  });
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      demand(req.get('Origin') === config.PUBLIC_URL && req.get('X-Requested-With') === 'Color',
        403, 'origin_rejected', 'Origem da solicitação inválida.');
      demand(req.is('application/json'), 415, 'json_required', 'Envie os dados em JSON.');
    }
    if (req.get('Origin')) demand(req.get('Origin') === config.PUBLIC_URL, 403, 'origin_rejected', 'Origem inválida.');
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));
  const dependencies = { pool, redis, stripe, config, auth: authMiddleware(pool, config), rate: rateLimiter(redis, config) };
  installMetrics(app, { pool, config, counters });
  await installAuth(app, dependencies);
  installAccount(app, dependencies);
  installJobs(app, dependencies);
  installPayments(app, dependencies);
  installPrivacy(app, dependencies);
  app.use('/api', (req, res) => res.status(404).json({ code: 'not_found', message: 'Página não encontrada.' }));
  app.use(express.static(resolve('dist'), { dotfiles: 'deny', index: 'index.html', etag: true,
    setHeaders: (res, path) => res.set('Cache-Control', /\/assets\//.test(path) ? 'public, max-age=3600' : 'no-cache') }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    log('request_failed', { requestId: req.requestId, code: status < 500 ? error.code || 'invalid_request' : 'internal_error' });
    res.status(status).json({ code: status < 500 ? error.code || 'invalid_request' : 'service_unavailable',
      message: status < 500 ? (error.code ? error.message : 'Solicitação inválida.') : 'Serviço temporariamente indisponível. Tente novamente.',
      requestId: req.requestId });
  });
  return app;
}
