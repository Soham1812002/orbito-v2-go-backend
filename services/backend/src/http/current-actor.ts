import type { Response } from 'express';
import type { Identity } from '../application/actor.js';
import { ApplicationError } from '../../../../shared/errors/application-error.js';

export function currentActor(res: Response): Identity {
  if (!res.locals.user) {
    throw new ApplicationError('unauthorized', 'Sign in required');
  }

  return res.locals.user;
}
