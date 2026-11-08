import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import 'dotenv/config';
import { database } from '../../services/backend/src/database/pool.js';
import { transaction } from '../../services/backend/src/database/transaction.js';

const { pool } = database(process.env.DATABASE_URL ?? '');

try {
  await transaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('fleet-migrations'))");
    await c.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const dir = new URL('../../services/backend/migrations/', import.meta.url);

    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = await readFile(new URL(file, dir), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const { rows } = await c.query('SELECT checksum FROM schema_migrations WHERE name=$1', [
        file,
      ]);

      if (rows[0]) {
        if (rows[0].checksum !== hash) {
          throw new Error(`Changed migration: ${file}`);
        }

        continue;
      }

      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [file, hash]);
      console.log(`Applied ${file}`);
    }
  });
} finally {
  await pool.end();
}
