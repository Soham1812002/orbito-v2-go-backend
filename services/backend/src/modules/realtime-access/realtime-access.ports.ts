import type { SocketIdentity } from '../../../../../shared/contracts/identity.js';

export interface RealtimeAccessRepository {
  issue(hash: string, sessionHash: string): Promise<void>;
  consume(hash: string): Promise<SocketIdentity | undefined>;
}
