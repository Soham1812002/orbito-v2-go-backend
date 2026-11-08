import type { RequestHandler } from 'express';
import type { Config } from '../../config/env.js';
import { HttpError } from '../../../../../shared/http/http-error.js';
import { currentActor } from '../../http/current-actor.js';
import { loginInput } from './auth.schemas.js';
import type { AuthService } from './auth.service.js';

export function authController(
  service: AuthService,
  config: Pick<Config, 'PUBLIC_ORIGIN' | 'SESSION_HOURS' | 'NODE_ENV'>,
) {
  return {
    login: (async (req, res) => {
      if (req.get('origin') !== config.PUBLIC_ORIGIN) {
        throw new HttpError(403, 'Invalid origin');
      }

      const { token } = await service.login(loginInput.parse(req.body));

      res.cookie('fleet_session', token, {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: config.SESSION_HOURS * 3600000,
      });
      res.json({ ok: true });
    }) satisfies RequestHandler,
    logout: (async (_req, res) => {
      await service.logout(currentActor(res).session_hash);
      res.clearCookie('fleet_session', { path: '/' });
      res.json({ ok: true });
    }) satisfies RequestHandler,
  };
}
