import type { SqlExecutor } from '../../database/executor.js';
import type { OutboxEntry } from './outbox.ports.js';
import type { DecodedEvent } from '../../../../../shared/contracts/events.js';

export function outboxWriter(db: SqlExecutor, newId: () => string) {
  return {
    async enqueue(org: string, device: string, log: string, event: DecodedEvent) {
      await db.query(
        `
      INSERT INTO
        realtime_outbox (id, organization_id, device_id, log_id, ingestion_event_id, trace_id, span_id)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7)
    `,
        [
          newId(),
          org,
          device,
          log,
          event.eventId,
          event.trace?.traceId ?? null,
          event.trace?.spanId ?? null,
        ],
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
        lease_until = now() + interval '60 seconds',
        lease_token = gen_random_uuid()
      FROM
        claim
      WHERE
        o.id = claim.id
      RETURNING
        o.*
    `)
      ).rows;
    },
    async renew(id: string, token: string) {
      const result = await db.query(
        "UPDATE realtime_outbox SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND dispatched_at IS NULL RETURNING id",
        [id, token],
      );

      return result.rowCount === 1;
    },
    async delivered(id: string, token: string) {
      await db.query(
        `
      UPDATE realtime_outbox
      SET
        dispatched_at = now(),
        lease_until = NULL
      WHERE
        id = $1 AND lease_token = $2
    `,
        [id, token],
      );
    },
    async retry(id: string, token: string) {
      await db.query(
        `
      UPDATE realtime_outbox
      SET
        attempts = attempts + 1,
        lease_until = NULL,
        next_attempt_at = now() + LEAST(30, power(2, LEAST(attempts, 5))) * interval '1 second'
      WHERE
        id = $1 AND lease_token = $2
    `,
        [id, token],
      );
    },
  };
}
