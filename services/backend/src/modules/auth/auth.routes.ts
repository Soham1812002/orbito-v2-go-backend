import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Config } from '../../config/env.js';
import type { AuthService } from './auth.service.js';
import { authController } from './auth.controller.js';
import { csrf, requireUser } from './auth.middleware.js';

export function authRoutes(service: AuthService, config: Config) {
  const r = Router();
  const controller = authController(service, config);

  r.get('/login', (_req, res) => res.render('login', { origin: config.PUBLIC_ORIGIN }));
  r.post(
    '/login',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
    controller.login,
  );
  r.post('/logout', requireUser, csrf(config.PUBLIC_ORIGIN), controller.logout);

  return r;
}
