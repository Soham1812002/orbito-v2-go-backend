import { logger } from './logger.js';

export function installProcessLogging() {
  const fail = (err: unknown) => {
    logger.fatal(
      { event: 'service.crashed', outcome: 'failure', err },
      'Unhandled service failure',
    );
    process.exitCode = 1;
    // Flush the console stream before exit; the container runner owns the file sink.
    logger.flush(() => process.exit(1));
  };

  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
}
