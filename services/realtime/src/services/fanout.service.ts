import { logger } from '../../../../shared/logging/logger.js';
import type { RealtimeEvent } from '../../../../shared/contracts/identity.js';
import type { FanoutDependencies } from './fanout.ports.js';

export function createFanoutService(deps: FanoutDependencies) {
  return async (event: RealtimeEvent) => {
    const sockets = await deps.connections(event.organizationId);

    let recipients = 0;

    await Promise.all(
      sockets.map(async (socket) => {
        try {
          const current = await deps.authorize(socket.identity.session_hash);

          if (current.organization_id !== event.organizationId) {
            socket.disconnect();

            return;
          }

          recipients++;
          socket.notify({ eventId: event.eventId, deviceId: event.deviceId, logId: event.logId });
        } catch {
          logger.warn(
            { event: 'socket.authorization.rejected', outcome: 'rejected' },
            'Socket authorization rejected',
          );
          socket.disconnect();
        }
      }),
    );
    logger.info(
      {
        event: 'notification.emitted',
        recipients,
        ingestionEventId: event.ingestionEventId,
        outboxId: event.eventId,
        logId: event.logId,
        deviceId: event.deviceId,
      },
      'Notification emission attempted',
    );
  };
}
