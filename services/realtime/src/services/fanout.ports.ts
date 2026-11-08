import type {
  ActiveIdentity,
  SocketIdentity,
  RealtimeEvent,
} from '../../../../shared/contracts/identity.js';

export type LogNotification = Omit<RealtimeEvent, 'organizationId'>;

export interface LiveConnection {
  identity: SocketIdentity;
  disconnect(): void;
  notify(event: LogNotification): void;
}

export interface FanoutDependencies {
  connections: (org: string) => Promise<LiveConnection[]>;
  authorize: (sessionHash: string) => Promise<ActiveIdentity>;
}
