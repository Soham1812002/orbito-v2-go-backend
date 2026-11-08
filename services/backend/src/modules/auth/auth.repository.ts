import type { SqlExecutor } from '../../database/executor.js';
import type { Identity } from '../../application/actor.js';
import type { AuthRepository, AuthUser } from './auth.ports.js';

export function authRepository(db: SqlExecutor): AuthRepository {
  return {
    async activeSession(hash) {
      return (
        await db.query<Identity>(
          `
      SELECT
        u.id,
        u.organization_id,
        u.role,
        u.email,
        s.csrf_token,
        s.token_hash AS session_hash
      FROM
        sessions s
        JOIN users u ON u.id = s.user_id
      WHERE
        s.token_hash = $1
        AND s.expires_at > now()
        AND u.enabled
    `,
          [hash],
        )
      ).rows[0];
    },
    async findUser(email) {
      return (
        await db.query<AuthUser>(
          `
      SELECT
        *
      FROM
        users
      WHERE
        email = $1
        AND enabled
    `,
          [email],
        )
      ).rows[0];
    },
    async createSession(hash, userId, csrf, hours) {
      await db.query(
        `
      INSERT INTO
        sessions (token_hash, user_id, csrf_token, expires_at)
      VALUES
        ($1, $2, $3, now() + $4 * interval '1 hour')
    `,
        [hash, userId, csrf, hours],
      );
    },
    async deleteSession(hash) {
      await db.query(
        `
      DELETE FROM sessions
      WHERE
        token_hash = $1
    `,
        [hash],
      );
    },
  };
}
