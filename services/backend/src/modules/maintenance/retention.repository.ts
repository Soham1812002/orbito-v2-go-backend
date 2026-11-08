import type { SqlExecutor } from '../../database/executor.js';

export async function retainRecords(db: SqlExecutor) {
  const lock = await db.query<{ locked: boolean }>(`
      SELECT
        pg_try_advisory_xact_lock(hashtext ('fleet-retention')) AS locked
    `);

  if (!lock.rows[0]?.locked) {
    return;
  }

  await db.query(`
      DELETE FROM sessions
      WHERE
        expires_at < now()
    `);
  await db.query(`
      DELETE FROM realtime_tickets
      WHERE
        expires_at < now()
    `);
  await db.query(`
      UPDATE device_logs
      SET
        raw_data = NULL
      WHERE
        id IN (
          SELECT
            id
          FROM
            device_logs
          WHERE
            raw_data IS NOT NULL
            AND received_at < now() - interval '7 days'
          LIMIT
            1000
        )
    `);
  await db.query(`
      DELETE FROM realtime_outbox
      WHERE
        id IN (
          SELECT
            id
          FROM
            realtime_outbox
          WHERE
            dispatched_at < now() - interval '1 day'
          LIMIT
            1000
        )
    `);
  await db.query(`
      DELETE FROM device_logs
      WHERE
        id IN (
          SELECT
            l.id
          FROM
            device_logs l
          WHERE
            l.received_at < now() - interval '30 days'
            AND NOT EXISTS (
              SELECT
                1
              FROM
                realtime_outbox o
              WHERE
                o.log_id = l.id
                AND o.dispatched_at IS NULL
            )
          LIMIT
            1000
        )
    `);
  await db.query(`
      DELETE FROM gps_points
      WHERE
        id IN (
          SELECT
            id
          FROM
            gps_points
          WHERE
            received_at < now() - interval '90 days'
          LIMIT
            1000
        )
    `);
  await db.query(`
      DELETE FROM ingestion_receipts
      WHERE
        event_id IN (
          SELECT
            r.event_id
          FROM
            ingestion_receipts r
          WHERE
            r.received_at < now() - interval '90 days'
            AND NOT EXISTS (
              SELECT
                1
              FROM
                device_logs l
              WHERE
                l.event_id = r.event_id
            )
            AND NOT EXISTS (
              SELECT
                1
              FROM
                gps_points p
              WHERE
                p.event_id = r.event_id
            )
          LIMIT
            1000
        )
    `);
}
