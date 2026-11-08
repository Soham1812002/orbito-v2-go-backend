import { ApplicationError } from '../../../../../shared/errors/application-error.js';
import type { AuthRepository } from '../auth/auth.ports.js';
import type { RealtimeAccessRepository } from './realtime-access.ports.js';

export function createRealtimeAccessService(deps: {
  repository: RealtimeAccessRepository;
  sessions: Pick<AuthRepository, 'activeSession'>;
  newToken: () => string;
  tokenHash: (token: string) => string;
}) {
  return {
    async issue(sessionHash: string) {
      const ticket = deps.newToken();

      await deps.repository.issue(deps.tokenHash(ticket), sessionHash);

      return { ticket };
    },
    async consume(ticket: string) {
      const identity = await deps.repository.consume(deps.tokenHash(ticket));

      if (!identity) {
        throw new ApplicationError('unauthorized', 'Expired or used ticket');
      }

      return identity;
    },
    async authorize(hash: string) {
      const identity = await deps.sessions.activeSession(hash);

      if (!identity) {
        throw new ApplicationError('unauthorized', 'Session revoked');
      }

      return { id: identity.id, organization_id: identity.organization_id, role: identity.role };
    },
  };
}

export type RealtimeAccessService = ReturnType<typeof createRealtimeAccessService>;
