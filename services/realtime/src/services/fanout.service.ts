import type { RealtimeEvent } from '../../../../shared/contracts/identity.js';
import type { FanoutDependencies } from './fanout.ports.js';

export function createFanoutService(deps: FanoutDependencies) {
  return async (event: RealtimeEvent) => {
    const sockets = await deps.connections(event.organizationId);

    await Promise.all(
      sockets.map(async (socket) => {
        try {
          const current = await deps.authorize(socket.identity.session_hash);

          if (current.organization_id !== event.organizationId) {
            socket.disconnect();

            return;
          }

          socket.notify({ eventId: event.eventId, deviceId: event.deviceId, logId: event.logId });
        } catch {
          socket.disconnect();
        }
      }),
    );
  };
}
