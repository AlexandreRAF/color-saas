import { loadConfig } from '../src/app/config.js';

export const testEnv = {
  NODE_ENV: 'test', PUBLIC_URL: 'https://color.test', DATABASE_URL: 'mysql://color:test@localhost/color_test',
  REDIS_URL: 'redis://localhost:6379', TOKEN_PEPPER: 'a'.repeat(64), MAIL_ENCRYPTION_KEY: 'b'.repeat(64),
  EMAIL_API_KEY: 'test-email', EMAIL_FROM: 'color@example.com', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake',
  STRIPE_PACK_SMALL_PRICE: 'price_small', STRIPE_PACK_LARGE_PRICE: 'price_large', RESEARCH_RUN_CAP_MICRO_USD: '200000',
  DEPLOYMENT_DAILY_CAP_MICRO_USD: '10000000', OPERATIONAL_RETENTION_DAYS: '30', FINANCIAL_RETENTION_DAYS: '1826',
  BACKUP_RETENTION_DAYS: '35', DELETION_AUDIT_RETENTION_DAYS: '365', RESEARCHER_VERSION: 'test',
};
export const config = loadConfig(testEnv);
export const input = { automobileType: 'car', brand: 'Volkswagen', model: 'Gol', manufacturingYear: 2015, country: 'Brasil' };
