import { ApplicationError } from '../../../../shared/errors/application-error.js';

export interface Actor {
  id: string;
  organization_id: string;
  role: 'admin' | 'operator' | 'viewer';
}

export interface Identity extends Actor {
  email: string;
  csrf_token: string;
  session_hash: string;
}

export function requireEditor(actor: Actor) {
  if (actor.role === 'viewer') {
    throw new ApplicationError('forbidden', 'Read-only access');
  }
}

export function requireAdmin(actor: Actor) {
  if (actor.role !== 'admin') {
    throw new ApplicationError('forbidden', 'Administrator required');
  }
}
