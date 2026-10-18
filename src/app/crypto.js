import { randomBytes, createHmac, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';

export const token = () => randomBytes(32).toString('base64url');
export const digest = (value, pepper) => createHmac('sha256', pepper).update(value).digest('hex');
export function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length
    && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function encrypt(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
export function decrypt(value, key) {
  const buffer = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), buffer.subarray(0, 12));
  cipher.setAuthTag(buffer.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString());
}
