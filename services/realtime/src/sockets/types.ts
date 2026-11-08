import type { Server, Socket } from 'socket.io';
import type { SocketIdentity } from '../../../../shared/contracts/identity.js';
import type { LogNotification } from '../services/fanout.ports.js';

export type ClientEvents = Record<string, never>;

export interface ServerEvents {
  'device:log': (event: LogNotification) => void;
}

export interface SocketData {
  identity: SocketIdentity;
}

export type RealtimeServer = Server<ClientEvents, ServerEvents, ClientEvents, SocketData>;

export type RealtimeSocket = Socket<ClientEvents, ServerEvents, ClientEvents, SocketData>;
