import express from 'express';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { rateLimit } from 'express-rate-limit';
import type { Config } from './config.js';
import { authRoutes, sessionLookup, requireUser, csrf } from './modules/auth.js';
import { vehicleRoutes } from './modules/vehicles.js';
import { gatewayRoutes } from './modules/ingestion.js';
import { logRoutes } from './modules/logs.js';
import { ticketRoutes, realtimeAuthRoutes } from './modules/realtime.js';
import { errors, requestId, serviceAuth } from './http.js';
export function createApp(pool: pg.Pool, config: Config) {
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY === 'true') app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', fileURLToPath(new URL('./views/', import.meta.url)));
  app.use(requestId, express.json({ limit: '64kb' }));
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    if (config.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.get('/health/live', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/health/ready', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });
  app.use('/internal/v1', serviceAuth(config.GATEWAY_SECRET), gatewayRoutes(pool, config));
  // Mount realtime endpoints on a separate path to avoid applying gateway credentials to them.
  app.use('/internal/realtime/v1', serviceAuth(config.REALTIME_SECRET), realtimeAuthRoutes(pool));
  app.use('/assets', express.static(fileURLToPath(new URL('./public/', import.meta.url))));
  app.use(
    '/assets/socket.io',
    express.static(
      fileURLToPath(new URL('../../../node_modules/socket.io-client/dist/', import.meta.url)),
    ),
  );
  app.use(sessionLookup(pool));
  app.use(authRoutes(pool, config));
  app.get('/', (_req, res) => res.redirect('/vehicles'));
  for (const page of ['vehicles', 'device-logs'])
    app.get(`/${page}`, (_req, res) => {
      if (!res.locals.user) {
        res.redirect('/login');
        return;
      }
      res.render(page, { user: res.locals.user, page, csrfToken: res.locals.user.csrf_token });
    });
  app.use(
    '/api/v1',
    rateLimit({ windowMs: 60000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }),
    requireUser,
    csrf(config.PUBLIC_ORIGIN),
    vehicleRoutes(pool),
    logRoutes(pool),
    ticketRoutes(pool),
  );
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use(errors);
  return app;
}
