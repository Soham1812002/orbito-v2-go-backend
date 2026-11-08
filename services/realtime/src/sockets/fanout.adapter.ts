import type { RealtimeServer } from './types.js';
import type { LiveConnection } from '../services/fanout.ports.js';
import { deviceRoom } from './rooms.js';

export function socketConnections(io: RealtimeServer) {
  return async (org: string): Promise<LiveConnection[]> => {
    const sockets = await io.in(deviceRoom(org)).fetchSockets();

    return sockets.map((socket) => ({
      identity: socket.data.identity,
      disconnect: () => {
        socket.disconnect(true);
      },
      notify: (event) => {
        socket.emit('device:log', event);
      },
    }));
  };
}
