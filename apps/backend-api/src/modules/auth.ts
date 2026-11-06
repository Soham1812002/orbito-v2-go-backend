import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import type { Config } from '../config.js';
import { HttpError } from '../http.js';
const scrypt = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('hex');
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = (await scrypt(password, salt)) as Buffer;
  return `scrypt-32768-8-3$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, hash] = stored.split('$');
  if (algorithm !== 'scrypt-32768-8-3' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = (await scrypt(password, salt)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export type Identity = {
  id: string;
  organization_id: string;
  role: 'admin' | 'operator' | 'viewer';
  email: string;
  csrf_token: string;
  session_hash: string;
};
export const sessionLookup =
  (pool: pg.Pool): RequestHandler =>
  async (req, res, next) => {
    const cookie = req.headers.cookie
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('fleet_session='))
      ?.slice(14);
    if (cookie && /^[a-f0-9]{64}$/.test(cookie)) {
      const { rows } = await pool.query(
        `SELECT u.id,u.organization_id,u.role,u.email,s.csrf_token,s.token_hash AS session_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.enabled`,
        [tokenHash(cookie)],
      );
      res.locals.user = rows[0];
    }
    next();
  };
export const requireUser: RequestHandler = (_req, res, next) => {
  if (!res.locals.user) {
    res.status(401).json({ error: 'Sign in required' });
    return;
  }
  next();
};
export const editor: RequestHandler = (_req, res, next) => {
  if (res.locals.user.role === 'viewer') throw new HttpError(403, 'Read-only access');
  next();
};
export const admin: RequestHandler = (_req, res, next) => {
  if (res.locals.user.role !== 'admin') throw new HttpError(403, 'Administrator required');
  next();
};
export const csrf =
  (origin: string): RequestHandler =>
  (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next();
      return;
    }
    if (req.get('origin') !== origin || req.get('x-csrf-token') !== res.locals.user?.csrf_token)
      throw new HttpError(403, 'Invalid request origin or CSRF token');
    next();
  };
export function authRoutes(pool: pg.Pool, config: Config) {
  const r = Router();
  r.get('/login', (_req, res) => res.render('login', { origin: config.PUBLIC_ORIGIN }));
  r.post(
    '/login',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
    async (req, res) => {
      if (req.get('origin') !== config.PUBLIC_ORIGIN) throw new HttpError(403, 'Invalid origin');
      const input = z
        .object({
          email: z
            .string()
            .email()
            .max(254)
            .transform((v) => v.toLowerCase()),
          password: z.string().min(1).max(256),
        })
        .parse(req.body);
      const { rows } = await pool.query('SELECT * FROM users WHERE email=$1 AND enabled', [
        input.email,
      ]);
      const user = rows[0];
      // Equal-cost password verification avoids a cheap unknown-account path.
      const valid = await verifyPassword(
        input.password,
        user?.password_hash ??
          `scrypt-32768-8-3$00000000000000000000000000000000$${'00'.repeat(64)}`,
      );
      if (!user || !valid) throw new HttpError(401, 'Invalid email or password');
      const token = randomToken();
      const csrfToken = randomToken();
      await pool.query(
        "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+$4*interval '1 hour')",
        [tokenHash(token), user.id, csrfToken, config.SESSION_HOURS],
      );
      res.cookie('fleet_session', token, {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: config.SESSION_HOURS * 3600000,
      });
      res.json({ ok: true });
    },
  );
  r.post('/logout', requireUser, csrf(config.PUBLIC_ORIGIN), async (_req, res) => {
    await pool.query('DELETE FROM sessions WHERE token_hash=$1', [res.locals.user.session_hash]);
    res.clearCookie('fleet_session', { path: '/' });
    res.json({ ok: true });
  });
  return r;
}
