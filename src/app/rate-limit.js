import { digest } from './crypto.js';
import { demand } from './errors.js';

const script = `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`;

export function rateLimiter(redis, config) {
  return (endpoint, max, seconds) => async (req, res, next) => {
    const identifiers = [`ip:${req.ip}`];
    if (typeof req.body?.email === 'string') identifiers.push(`email:${req.body.email.trim().toLowerCase()}`);
    if (req.user) identifiers.push(`user:${req.user.id}`);
    const counts = await Promise.all(identifiers.map(id => redis.eval(script, 1,
      `rate:${endpoint}:${digest(id, config.TOKEN_PEPPER)}`, seconds)));
    if (counts.some(count => count > max)) res.set('Retry-After', String(seconds));
    demand(counts.every(count => count <= max), 429, 'rate_limited', 'Muitas tentativas. Aguarde alguns minutos.');
    next();
  };
}
