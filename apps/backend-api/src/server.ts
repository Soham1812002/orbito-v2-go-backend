import { readConfig } from './config.js';
import { database } from './db/index.js';
import { createApp } from './app.js';
import { startJobs } from './jobs.js';
import { logger } from './http.js';
const config = readConfig();
const { pool } = database(config.DATABASE_URL);
const stopJobs = startJobs(pool, config);
const server = createApp(pool, config).listen(config.PORT, '0.0.0.0', () =>
  logger.info({ port: config.PORT }, 'API listening'),
);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 30000).unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopJobs();
  await pool.end();
  clearTimeout(deadline);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
