import pg from 'pg';

export function database(url: string) {
  const pool = new pg.Pool({
    connectionString: url,
    max: 8,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    idleTimeoutMillis: 30000,
  });

  return { pool };
}

export async function checkDatabase(pool: pg.Pool) {
  await pool.query('SELECT 1');
}
