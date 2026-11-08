import { logger } from '../../../shared/logging/logger.js';
import { installProcessLogging } from '../../../shared/logging/process.js';
import { readRealtimeConfig } from './config/env.js';
import { bootstrapRealtime } from './bootstrap.js';

installProcessLogging();
const config = readRealtimeConfig();
const runtime = bootstrapRealtime(config);

runtime.server.listen(config.REALTIME_PORT, '0.0.0.0', () =>
  logger.info({ event: 'service.started', port: config.REALTIME_PORT }, 'Realtime listening'),
);
let stopping = false;
const stop = () => {
  if (stopping) {
    return;
  }

  stopping = true;
  logger.info({ event: 'service.stopping' }, 'Realtime stopping');
  runtime.io.close().catch((err: unknown) => {
    logger.error({ err }, 'Realtime shutdown failed');
    process.exitCode = 1;
  });
};

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
