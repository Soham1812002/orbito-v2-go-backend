import type { RealtimeConfig } from './config/env.js';
import { createBackendClient } from './clients/backend.client.js';
import { createRealtime } from './app.js';

export function bootstrapRealtime(config: RealtimeConfig) {
  return createRealtime(
    createBackendClient({ apiUrl: config.API_URL, secret: config.REALTIME_SECRET }),
    { secret: config.REALTIME_SECRET, origin: config.PUBLIC_ORIGIN },
  );
}
