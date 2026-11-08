import { createBackend } from './bootstrap.js';
import { readConfig } from './config/env.js';
import { database } from './database/pool.js';
import { createApp } from './app.js';
import { startJobs } from './jobs/scheduler.js';
import { logger } from '../../../shared/logging/logger.js';
import { installProcessLogging } from '../../../shared/logging/process.js';

installProcessLogging();
const config = readConfig();
const { pool } = database(config.DATABASE_URL);
const services = createBackend(pool, config);
const stopJobs = startJobs(services.jobs);
const server = createApp(services, config).listen(config.PORT, '0.0.0.0', () =>
  logger.info({ event: 'service.started', port: config.PORT }, 'API listening'),
);
let stopping = false;

async function shutdown() {
  if (stopping) {
    return;
  }

  stopping = true;
  logger.info({ event: 'service.stopping' }, 'API stopping');
  const deadline = setTimeout(() => process.exit(1), 30000).unref();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopJobs();
  await pool.end();
  clearTimeout(deadline);
}

process.on('SIGTERM', () => {
  void shutdown().catch((err) => {
    logger.error({ err }, 'Shutdown failed');
    process.exitCode = 1;
  });
});
process.on('SIGINT', () => void shutdown());
