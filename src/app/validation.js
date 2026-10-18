import { z } from 'zod';
import { AppError } from './errors.js';

const text = max => z.string().trim().min(1).max(max).refine(v => !/[\x00-\x1f\x7f]/.test(v));
export const email = z.email().max(254).transform(v => v.toLowerCase());
export const password = z.string().min(12).max(128);
export const credentials = z.strictObject({ email, password });
export const vehicle = z.strictObject({
  automobileType: text(60), brand: text(80), model: text(100),
  manufacturingYear: z.number().int().min(1886).max(new Date().getUTCFullYear() + 1),
  country: text(60), predominantColor: text(60).optional(),
  paintFinish: z.enum(['solid', 'metallic', 'pearlescent', 'matte']).optional(),
});
export const keySchema = z.string().regex(/^[A-Za-z0-9_-]{16,100}$/);
export const idSchema = z.uuid();
export function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, 'invalid_input', 'Confira os campos informados.');
  return result.data;
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
