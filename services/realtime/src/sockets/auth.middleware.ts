import { logger } from '../../../../shared/logging/logger.js';
import type { RealtimeServer } from './types.js';
import { ticketInput } from '../../../../shared/contracts/identity.js';
import type { BackendClient } from '../clients/backend.client.js';
import { deviceRoom } from './rooms.js';
import { monitorSession } from './session-monitor.js';

export function authenticateSockets(io: RealtimeServer, client: BackendClient) {
  io.use(async (socket, next) => {
    try {
      const { ticket } = ticketInput.parse(socket.handshake.auth);

      socket.data.identity = await client.consume(ticket);
      next();
    } catch {
      logger.warn({ event: 'socket.login.rejected', outcome: 'rejected' }, 'Socket login rejected');
      next(new Error('Unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    logger.info({ event: 'socket.connected', socketId: socket.id }, 'Socket connected');
    void socket.join(deviceRoom(socket.data.identity.organization_id));
    const stop = monitorSession(socket, client);

    socket.on('disconnect', () => {
      stop();
      logger.info({ event: 'socket.disconnected', socketId: socket.id }, 'Socket disconnected');
    });
  });
}
