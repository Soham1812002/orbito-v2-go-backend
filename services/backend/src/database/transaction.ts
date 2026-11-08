import { logger } from '../../../../shared/logging/logger.js';
import type pg from 'pg';

export async function transaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const c = await pool.connect();

  try {
    await c.query('BEGIN');
    const result = await fn(c);

    await c.query('COMMIT');
    logger.debug(
      { event: 'database.committed', durationMs: Math.round(performance.now() - started) },
      'Database transaction committed',
    );

    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    logger.warn(
      {
        event: 'database.rolled_back',
        outcome: 'failure',
        err: e,
        durationMs: Math.round(performance.now() - started),
      },
      'Database transaction rolled back',
    );
    throw e;
  } finally {
    c.release();
  }
}
