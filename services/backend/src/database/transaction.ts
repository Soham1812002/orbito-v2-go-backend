import type pg from 'pg';

export async function transaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();

  try {
    await c.query('BEGIN');
    const result = await fn(c);

    await c.query('COMMIT');

    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
