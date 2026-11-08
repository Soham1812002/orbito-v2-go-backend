import type { RealtimeSocket } from './types.js';
import type { BackendClient } from '../clients/backend.client.js';

export function monitorSession(socket: RealtimeSocket, client: Pick<BackendClient, 'authorize'>) {
  const identity = socket.data.identity;
  const timer = setInterval(() => {
    void client
      .authorize(identity.session_hash)
      .then((current) => {
        if (current.organization_id !== identity.organization_id || current.id !== identity.id) {
          socket.disconnect(true);
        }
      })
      .catch(() => socket.disconnect(true));
  }, 30000);

  return () => clearInterval(timer);
}
