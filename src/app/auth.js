import { randomInt, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { z } from 'zod';
import { rows, transaction } from './db.js';
import { digest, token, equal, encrypt } from './crypto.js';
import { parse, credentials, email, password } from './validation.js';
import { demand } from './errors.js';

export const SESSION_COOKIE = '__Host-color_session';
export const hashPassword = value => argon2.hash(value, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
const generic = { message: 'Se os dados corresponderem a uma conta, enviaremos as instruções por e-mail.' };

export function sessionToken(req) {
  const value = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value || '') ? value : null;
}

export async function getSession(pool, config, raw) {
  if (!raw) return null;
  return (await rows(pool, `SELECT s.digest, s.csrf_digest, s.expires_at, u.id, u.email,
    u.verified_at, u.balance, u.reserved, u.deletion_requested_at FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.digest=? AND s.revoked_at IS NULL
    AND s.expires_at>UTC_TIMESTAMP(3) AND u.deleted_at IS NULL AND u.deletion_requested_at IS NULL`, [digest(raw, config.TOKEN_PEPPER)]))[0] || null;
}

export function authMiddleware(pool, config) {
  return async (req, res, next) => {
    req.rawSession = sessionToken(req);
    req.user = await getSession(pool, config, req.rawSession);
    demand(req.user, 401, 'unauthorized', 'Entre na sua conta para continuar.');
    if (!['GET', 'HEAD'].includes(req.method)) {
      const supplied = req.get('x-csrf-token');
      demand(typeof supplied === 'string' && equal(digest(supplied, config.TOKEN_PEPPER), req.user.csrf_digest),
        403, 'csrf', 'Atualize a página e tente novamente.');
    }
    next();
  };
}

async function issueChallenge(db, config, user, kind) {
  const recent = await rows(db, `SELECT id FROM challenges WHERE user_id=? AND kind=?
    AND created_at>DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 60 SECOND) LIMIT 1`, [user.id, kind]);
  if (recent.length) return;
  const secret = kind === 'verify' ? String(randomInt(100000, 1000000)) : token();
  const ttl = kind === 'verify' ? config.EMAIL_CODE_TTL_MINUTES : config.PASSWORD_RESET_TTL_MINUTES;
  const expires = new Date(Date.now() + ttl * 60000);
  await rows(db, 'UPDATE challenges SET used_at=UTC_TIMESTAMP(3) WHERE user_id=? AND kind=? AND used_at IS NULL', [user.id, kind]);
  await rows(db, 'INSERT INTO challenges(id,user_id,kind,digest,expires_at) VALUES(?,?,?,?,?)',
    [randomUUID(), user.id, kind, digest(`${kind}:${user.id}:${secret}`, config.TOKEN_PEPPER), expires]);
  const subject = kind === 'verify' ? 'Confirme seu e-mail no Color' : 'Redefina sua senha no Color';
  const text = `${kind === 'verify' ? 'Código de confirmação' : 'Código para redefinir sua senha'}: ${secret}\n\nVálido por ${ttl} minutos. Abra ${config.PUBLIC_URL}/app/ e informe o código. Se você não solicitou, ignore esta mensagem.`;
  await rows(db, 'INSERT INTO email_outbox(id,user_id,payload,available_at,expires_at) VALUES(?,?,?,UTC_TIMESTAMP(3),?)',
    [randomUUID(), user.id, encrypt({ to: user.email, subject, text }, config.MAIL_ENCRYPTION_KEY), expires]);
}

async function consumeChallenge(db, config, user, kind, secret) {
  const challenge = (await rows(db, `SELECT * FROM challenges WHERE user_id=? AND kind=? AND used_at IS NULL
    AND expires_at>UTC_TIMESTAMP(3) ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [user.id, kind]))[0];
  if (!challenge || challenge.attempts >= 5) return false;
  const valid = equal(challenge.digest, digest(`${kind}:${user.id}:${secret}`, config.TOKEN_PEPPER));
  await rows(db, 'UPDATE challenges SET attempts=attempts+1, used_at=? WHERE id=?', [valid ? new Date() : null, challenge.id]);
  return valid;
}

export async function installAuth(app, { pool, config, rate }) {
  // A real Argon2 verification for nonexistent users reduces account enumeration by timing.
  const dummyHash = await hashPassword(token());
  app.post('/api/auth/register', rate('register', 8, 3600), async (req, res) => {
    const input = parse(credentials, req.body);
    const hash = await hashPassword(input.password);
    await transaction(pool, async db => {
      const user = { id: randomUUID(), email: input.email };
      try {
        await rows(db, 'INSERT INTO users(id,email,password_hash) VALUES(?,?,?)', [user.id, user.email, hash]);
      } catch (error) { if (error.code === 'ER_DUP_ENTRY') return; throw error; }
      await rows(db, `INSERT INTO ledger(user_id,kind,balance_delta,reserved_delta,reference)
        VALUES(?,'grant',3,0,?)`, [user.id, `welcome:${user.id}`]);
      await issueChallenge(db, config, user, 'verify');
    });
    res.status(202).json(generic);
  });

  app.post('/api/auth/login', rate('login', 12, 900), async (req, res) => {
    const input = parse(credentials, req.body);
    const found = (await rows(pool, 'SELECT * FROM users WHERE email=? AND deleted_at IS NULL AND deletion_requested_at IS NULL', [input.email]))[0];
    const valid = await argon2.verify(found?.password_hash || dummyHash, input.password);
    demand(valid && found, 401, 'invalid_credentials', 'E-mail ou senha inválidos.');
    const raw = token();
    const csrf = digest(`csrf:${raw}`, config.TOKEN_PEPPER);
    const expires = new Date(Date.now() + config.SESSION_TTL_DAYS * 86400000);
    await transaction(pool, async db => {
      const current = (await rows(db, 'SELECT password_hash,deleted_at,deletion_requested_at FROM users WHERE id=? FOR UPDATE', [found.id]))[0];
      demand(!current.deleted_at && !current.deletion_requested_at && current.password_hash === found.password_hash, 401, 'invalid_credentials', 'Entre novamente.');
      const previous = sessionToken(req);
      if (previous) await rows(db, 'UPDATE sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE digest=?', [digest(previous, config.TOKEN_PEPPER)]);
      await rows(db, 'INSERT INTO sessions(digest,user_id,csrf_digest,created_at,expires_at) VALUES(?,?,?,UTC_TIMESTAMP(3),?)',
        [digest(raw, config.TOKEN_PEPPER), found.id, digest(csrf, config.TOKEN_PEPPER), expires]);
    });
    res.cookie(SESSION_COOKIE, raw, { secure: true, httpOnly: true, sameSite: 'lax', path: '/', expires });
    res.json({ csrf });
  });

  for (const kind of ['verify', 'reset']) {
    const route = kind === 'verify' ? 'resend' : 'forgot-password';
    app.post(`/api/auth/${route}`, rate(route, 5, 3600), async (req, res) => {
      const input = parse(z.strictObject({ email }), req.body);
      await transaction(pool, async db => {
        const user = (await rows(db, 'SELECT * FROM users WHERE email=? AND deleted_at IS NULL FOR UPDATE', [input.email]))[0];
        if (user && (kind === 'reset' || !user.verified_at)) await issueChallenge(db, config, user, kind);
      });
      res.status(202).json(generic);
    });
  }

  app.post('/api/auth/verify', rate('verify', 15, 900), async (req, res) => {
    const input = parse(z.strictObject({ email, code: z.string().regex(/^\d{6}$/) }), req.body);
    const valid = await transaction(pool, async db => {
      const user = (await rows(db, 'SELECT * FROM users WHERE email=? AND deleted_at IS NULL FOR UPDATE', [input.email]))[0];
      if (!user || !await consumeChallenge(db, config, user, 'verify', input.code)) return false;
      await rows(db, 'UPDATE users SET verified_at=COALESCE(verified_at,UTC_TIMESTAMP(3)) WHERE id=?', [user.id]);
      // Privilege changes revoke existing sessions; the next login rotates tokens.
      await rows(db, 'UPDATE sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE user_id=?', [user.id]);
      return true;
    });
    demand(valid, 400, 'invalid_code', 'Código inválido ou expirado.');
    res.json({ message: 'E-mail confirmado. Entre para usar seus créditos.' });
  });

  app.post('/api/auth/reset-password', rate('reset-password', 10, 900), async (req, res) => {
    const input = parse(z.strictObject({ email, token: z.string().regex(/^[\w-]{43}$/), password }), req.body);
    const hash = await hashPassword(input.password);
    const valid = await transaction(pool, async db => {
      const user = (await rows(db, 'SELECT * FROM users WHERE email=? AND deleted_at IS NULL FOR UPDATE', [input.email]))[0];
      if (!user || !await consumeChallenge(db, config, user, 'reset', input.token)) return false;
      await rows(db, 'UPDATE users SET password_hash=? WHERE id=?', [hash, user.id]);
      await rows(db, 'UPDATE sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE user_id=?', [user.id]);
      return true;
    });
    demand(valid, 400, 'invalid_code', 'Código inválido ou expirado.');
    res.json({ message: 'Senha alterada. Entre novamente.' });
  });
}

export function installAccount(app, { pool, config, auth }) {
  app.get('/api/me', auth, (req, res) => {
    res.json({ email: req.user.email, verified: Boolean(req.user.verified_at),
      available: Math.max(0, req.user.balance - req.user.reserved), reserved: req.user.reserved,
      debt: Math.max(0, -req.user.balance), lowCreditThreshold: config.LOW_CREDIT_THRESHOLD,
      historyDays: config.HISTORY_RETENTION_DAYS, deletionRequested: Boolean(req.user.deletion_requested_at),
      csrf: digest(`csrf:${req.rawSession}`, config.TOKEN_PEPPER) });
  });
  app.post('/api/logout', auth, async (req, res) => {
    const { all } = parse(z.strictObject({ all: z.boolean().default(false) }), req.body);
    await rows(pool, `UPDATE sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE ${all ? 'user_id' : 'digest'}=?`, [all ? req.user.id : req.user.digest]);
    res.clearCookie(SESSION_COOKIE, { secure: true, httpOnly: true, sameSite: 'lax', path: '/' });
    res.sendStatus(204);
  });
}
