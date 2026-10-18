import { z } from 'zod';

const integer = (fallback, min = 1, max = 2147483647) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const required = z.string().trim().min(1);
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: integer(3000, 1, 65535),
  PUBLIC_URL: z.url(),
  DATABASE_URL: required,
  DATABASE_CA_FILE: z.string().optional(),
  REDIS_URL: z.url(),
  TOKEN_PEPPER: z.string().default(''),
  MAIL_ENCRYPTION_KEY: z.string().default(''),
  EMAIL_API_URL: z.url().default('https://api.resend.com/emails'),
  EMAIL_API_KEY: z.string().default(''),
  EMAIL_FROM: z.string().default(''),
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  STRIPE_MODE: z.enum(['test', 'live']).default('test'),
  STRIPE_PACK_SMALL_PRICE: z.string().default(''),
  STRIPE_PACK_LARGE_PRICE: z.string().default(''),
  AGENT_CONCURRENCY: integer(4, 1, 100),
  SESSION_TTL_DAYS: integer(14, 1, 90),
  HISTORY_RETENTION_DAYS: integer(7, 1, 365),
  EMAIL_CODE_TTL_MINUTES: integer(10, 1, 60),
  PASSWORD_RESET_TTL_MINUTES: integer(15, 1, 60),
  MAX_OUTSTANDING_JOBS_PER_USER: integer(2),
  RESEARCH_QUEUE_MAX_OUTSTANDING: integer(100),
  RESEARCH_QUEUE_WAIT_TIMEOUT_SECONDS: integer(900),
  RESEARCH_JOB_TIMEOUT_SECONDS: integer(120, 5, 600),
  RESEARCH_MAX_ATTEMPTS: integer(2, 1, 5),
  LOW_CREDIT_THRESHOLD: integer(1, 0),
  SHUTDOWN_GRACE_SECONDS: integer(130, 5, 660),
  RESEARCH_RUN_CAP_MICRO_USD: z.coerce.number().int().min(25000).max(10000000),
  SEARCH_REQUEST_MICRO_USD: integer(1000, 1, 100000),
  DEPLOYMENT_DAILY_CAP_MICRO_USD: z.coerce.number().int().positive(),
  PROVIDER_FAILURE_THRESHOLD: integer(5),
  PROVIDER_PAUSE_SECONDS: integer(120),
  MAIL_MAX_ATTEMPTS: integer(5, 1, 10),
  OPERATIONAL_RETENTION_DAYS: z.coerce.number().int().positive(),
  FINANCIAL_RETENTION_DAYS: z.coerce.number().int().positive(),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().positive(),
  DELETION_AUDIT_RETENTION_DAYS: z.coerce.number().int().positive(),
  CAPACITY_SOCKET: z.string().optional(),
  LAZZUMIX_DATABASE_PATH: z.string().default('/data/catalogs/lazzumix.db'),
  BASF_DATABASE_PATH: z.string().default('/data/catalogs/basf.db'),
  BASF_MODELS_DATABASE_PATH: z.string().default('src/agentic_researcher/data/basf_models.db'),
  RESEARCHER_VERSION: required,
  TRUST_PROXY_HOPS: integer(0, 0, 5),
  METRICS_TOKEN: z.string().default(''),
});

export function loadConfig(env = process.env, role = 'api') {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`);
  const c = parsed.data;
  const url = new URL(c.PUBLIC_URL);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('PUBLIC_URL must be an HTTPS origin, including in local development');
  let database;
  try { database = new URL(c.DATABASE_URL); } catch { throw new Error('Invalid DATABASE_URL'); }
  if (database.protocol !== 'mysql:' || !database.hostname || !database.username || database.pathname.length < 2)
    throw new Error('DATABASE_URL must specify a MySQL host, user and database');
  if (!['redis:', 'rediss:'].includes(new URL(c.REDIS_URL).protocol)) throw new Error('Invalid REDIS_URL');
  const emailUrl = new URL(c.EMAIL_API_URL);
  if (emailUrl.protocol !== 'https:' || emailUrl.username || emailUrl.password) throw new Error('EMAIL_API_URL must use HTTPS without embedded credentials');
  if (c.METRICS_TOKEN && c.METRICS_TOKEN.length < 32) throw new Error('METRICS_TOKEN must have at least 32 characters');
  if (c.SHUTDOWN_GRACE_SECONDS < c.RESEARCH_JOB_TIMEOUT_SECONDS + 5)
    throw new Error('SHUTDOWN_GRACE_SECONDS must exceed the execution deadline by at least 5 seconds');
  if (c.MAX_OUTSTANDING_JOBS_PER_USER > c.RESEARCH_QUEUE_MAX_OUTSTANDING)
    throw new Error('Per-user queue limit must not exceed the deployment limit');
  if (c.DEPLOYMENT_DAILY_CAP_MICRO_USD < c.RESEARCH_RUN_CAP_MICRO_USD)
    throw new Error('Daily spending cap must cover at least one run');
  if (c.RESEARCH_RUN_CAP_MICRO_USD / c.RESEARCH_MAX_ATTEMPTS < 20 * c.SEARCH_REQUEST_MICRO_USD + 1000)
    throw new Error('Per-attempt spending allocation must cover the bounded search allowance');
  if (['api', 'maintenance'].includes(role) && !c.STRIPE_SECRET_KEY.startsWith(c.STRIPE_MODE === 'live' ? 'sk_live_' : 'sk_test_'))
    throw new Error('Stripe credential does not match STRIPE_MODE');
  if (role === 'api' && (c.TOKEN_PEPPER.length < 32 || !c.STRIPE_WEBHOOK_SECRET || !c.STRIPE_PACK_SMALL_PRICE || !c.STRIPE_PACK_LARGE_PRICE))
    throw new Error('API requires session and Stripe secrets and pack price identifiers');
  if (['api', 'maintenance'].includes(role) && !/^[a-fA-F0-9]{64}$/.test(c.MAIL_ENCRYPTION_KEY))
    throw new Error('MAIL_ENCRYPTION_KEY must be a 256-bit hex key');
  if (role === 'maintenance' && (!c.EMAIL_API_KEY || !c.EMAIL_FROM)) throw new Error('Maintenance requires email provider configuration');
  if (c.NODE_ENV === 'production' && (!c.DATABASE_CA_FILE || !c.REDIS_URL.startsWith('rediss://') || (role === 'worker' && !c.CAPACITY_SOCKET)))
    throw new Error('Production requires MySQL TLS, Redis TLS and a shared provider capacity coordinator');
  return Object.freeze({ ...c, PUBLIC_URL: url.origin,
    packs: [{ id: 'small', credits: 10, amount: 1990, currency: 'brl', price: c.STRIPE_PACK_SMALL_PRICE },
      { id: 'large', credits: 30, amount: 4990, currency: 'brl', price: c.STRIPE_PACK_LARGE_PRICE }] });
}
