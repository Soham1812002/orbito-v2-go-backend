import type { SqlExecutor } from '../../database/executor.js';
import type { OutboxEntry } from './outbox.ports.js';

export function outboxWriter(db: SqlExecutor, newId: () => string) {
  return {
    async enqueue(org: string, device: string, log: string) {
      await db.query(
        `
      INSERT INTO
        realtime_outbox (id, organization_id, device_id, log_id)
      VALUES
        ($1, $2, $3, $4)
    `,
        [newId(), org, device, log],
      );
    },
  };
}

export function outboxRepository(db: SqlExecutor) {
  return {
    async claim() {
      return (
        await db.query<OutboxEntry>(`
      WITH
        claim AS (
          SELECT
            id
          FROM
            realtime_outbox
          WHERE
            dispatched_at IS NULL
            AND next_attempt_at <= now()
            AND (
              lease_until IS NULL
              OR lease_until < now()
            )
          ORDER BY
            created_at
          LIMIT
            25
          FOR UPDATE
            SKIP LOCKED
        )
      UPDATE realtime_outbox o
      SET
        lease_until = now() + interval '60 seconds'
      FROM
        claim
      WHERE
        o.id = claim.id
      RETURNING
        o.*
    `)
      ).rows;
    },
    async delivered(id: string) {
      await db.query(
        `
      UPDATE realtime_outbox
      SET
        dispatched_at = now(),
        lease_until = NULL
      WHERE
        id = $1
    `,
        [id],
      );
    },
    async retry(id: string) {
      await db.query(
        `
      UPDATE realtime_outbox
      SET
        attempts = attempts + 1,
        lease_until = NULL,
        next_attempt_at = now() + LEAST(30, power(2, LEAST(attempts, 5))) * interval '1 second'
      WHERE
        id = $1
    `,
        [id],
      );
    },
  };
}
