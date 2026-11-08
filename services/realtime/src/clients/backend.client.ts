import { activeIdentity, socketIdentity } from '../../../../shared/contracts/identity.js';
import type { ActiveIdentity, SocketIdentity } from '../../../../shared/contracts/identity.js';
import { internalPost } from '../../../../shared/http/internal-client.js';

export interface BackendClient {
  consume(ticket: string): Promise<SocketIdentity>;
  authorize(sessionHash: string): Promise<ActiveIdentity>;
}

export function createBackendClient(config: { apiUrl: string; secret: string }): BackendClient {
  return {
    async consume(ticket) {
      return socketIdentity.parse(
        await internalPost(
          `${config.apiUrl}/internal/realtime/v1/realtime-tickets/consume`,
          config.secret,
          { ticket },
        ),
      );
    },
    async authorize(sessionHash) {
      return activeIdentity.parse(
        await internalPost(
          `${config.apiUrl}/internal/realtime/v1/subscriptions/authorize`,
          config.secret,
          { sessionHash },
        ),
      );
    },
  };
}
