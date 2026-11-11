import { logger } from '../../../../shared/logging/logger.js';
import type { RealtimeEvent } from '../../../../shared/contracts/identity.js';
import type { FanoutDependencies } from './fanout.ports.js';

export function createFanoutService(deps: FanoutDependencies) {
  return async (event: RealtimeEvent) => {
    const sockets = await deps.connections(event.organizationId);

    let recipients = 0;

    const authorizations = new Map<string, ReturnType<typeof deps.authorize>>();

    // Limit authorization requests and reuse only within this single fanout; no stale auth cache.
    for (let offset = 0; offset < sockets.length; offset += 8) {
      await Promise.all(
        sockets.slice(offset, offset + 8).map(async (socket) => {
          try {
            const hash = socket.identity.session_hash;
            let authorization = authorizations.get(hash);

            if (!authorization) {
              authorization = deps.authorize(hash);
              authorizations.set(hash, authorization);
            }

            const current = await authorization;

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
    }

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
