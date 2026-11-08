import type { RequestHandler } from 'express';
import { HttpError } from '../../../../../shared/http/http-error.js';
import { requireEditor, requireAdmin } from '../../application/actor.js';
import { currentActor } from '../../http/current-actor.js';
import type { AuthService } from './auth.service.js';

export const sessionLookup =
  (service: Pick<AuthService, 'lookupSession'>): RequestHandler =>
  async (req, res, next) => {
    const cookie = req.headers.cookie
      ?.split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('fleet_session='))
      ?.slice(14);

    if (cookie && /^[a-f0-9]{64}$/.test(cookie)) {
      res.locals.user = await service.lookupSession(cookie);
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
  requireEditor(currentActor(res));
  next();
};

export const admin: RequestHandler = (_req, res, next) => {
  requireAdmin(currentActor(res));
  next();
};

export const csrf =
  (origin: string): RequestHandler =>
  (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next();

      return;
    }

    if (req.get('origin') !== origin || req.get('x-csrf-token') !== res.locals.user?.csrf_token) {
      throw new HttpError(403, 'Invalid request origin or CSRF token');
    }

    next();
  };
