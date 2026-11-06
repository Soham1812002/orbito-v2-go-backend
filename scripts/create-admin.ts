import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { database, transaction } from '../apps/backend-api/src/db/index.js';
import { hashPassword } from '../apps/backend-api/src/modules/auth.js';
const input = z
  .object({
    DATABASE_URL: z.string().min(1),
    ADMIN_EMAIL: z.string().email(),
    ADMIN_PASSWORD: z.string().min(12).max(256),
    ORGANIZATION_NAME: z.string().min(1).default('My Fleet'),
  })
  .parse(process.env);
const { pool } = database(input.DATABASE_URL);
try {
  const passwordHash = await hashPassword(input.ADMIN_PASSWORD);
  await transaction(pool, async (c) => {
    const org = randomUUID();
    await c.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [
      org,
      input.ORGANIZATION_NAME,
    ]);
    await c.query(
      "INSERT INTO users(id,organization_id,email,password_hash,role) VALUES($1,$2,$3,$4,'admin')",
      [randomUUID(), org, input.ADMIN_EMAIL.toLowerCase(), passwordHash],
    );
  });
  console.log('Administrator created. Remove ADMIN_PASSWORD from the environment.');
} finally {
  await pool.end();
}
