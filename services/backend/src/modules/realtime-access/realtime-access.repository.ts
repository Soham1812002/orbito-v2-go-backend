import type { SqlExecutor } from '../../database/executor.js';
import type { SocketIdentity } from '../../../../../shared/contracts/identity.js';
import type { RealtimeAccessRepository } from './realtime-access.ports.js';

export function realtimeAccessRepository(db: SqlExecutor): RealtimeAccessRepository {
  return {
    async issue(hash, sessionHash) {
      await db.query(
        `
      INSERT INTO
        realtime_tickets (token_hash, session_hash, expires_at)
      VALUES
        ($1, $2, now() + interval '30 seconds')
    `,
        [hash, sessionHash],
      );
    },
    async consume(hash) {
      return (
        await db.query<SocketIdentity>(
          `
      WITH
        consumed AS (
          DELETE FROM realtime_tickets
          WHERE
            token_hash = $1
            AND expires_at > now()
          RETURNING
            session_hash
        )
      SELECT
        u.id,
        u.organization_id,
        u.role,
        s.token_hash AS session_hash
      FROM
        consumed t
        JOIN sessions s ON s.token_hash = t.session_hash
        JOIN users u ON u.id = s.user_id
      WHERE
        s.expires_at > now()
        AND u.enabled
    `,
          [hash],
        )
      ).rows[0];
    },
  };
}
