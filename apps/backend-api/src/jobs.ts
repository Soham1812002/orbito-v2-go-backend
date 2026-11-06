import type pg from 'pg';
import type { Config } from './config.js';
import { transaction } from './db/index.js';
import { internalPost, logger } from './http.js';
export async function dispatchOutbox(pool: pg.Pool, config: Config) {
  const rows = await transaction(pool, async (c) => {
    const result = await c.query(
      `WITH claim AS (SELECT id FROM realtime_outbox WHERE dispatched_at IS NULL AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at LIMIT 25 FOR UPDATE SKIP LOCKED) UPDATE realtime_outbox o SET lease_until=now()+interval '60 seconds' FROM claim WHERE o.id=claim.id RETURNING o.*`,
    );
    return result.rows;
  });
  for (const row of rows) {
    try {
      await internalPost(`${config.REALTIME_URL}/internal/v1/events`, config.REALTIME_SECRET, {
        eventId: row.id,
        organizationId: row.organization_id,
        deviceId: row.device_id,
        logId: row.log_id,
      });
      await pool.query(
        'UPDATE realtime_outbox SET dispatched_at=now(),lease_until=NULL WHERE id=$1',
        [row.id],
      );
    } catch (err) {
      logger.warn({ err, outboxId: row.id }, 'Realtime delivery retry');
      await pool.query(
        "UPDATE realtime_outbox SET attempts=attempts+1,lease_until=NULL,next_attempt_at=now()+LEAST(30,power(2,LEAST(attempts,5))) * interval '1 second' WHERE id=$1",
        [row.id],
      );
    }
  }
}
export async function retention(pool: pg.Pool) {
  await transaction(pool, async (c) => {
    const lock = await c.query(
      "SELECT pg_try_advisory_xact_lock(hashtext('fleet-retention')) AS locked",
    );
    if (!lock.rows[0].locked) return;
    await c.query('DELETE FROM sessions WHERE expires_at<now()');
    await c.query('DELETE FROM realtime_tickets WHERE expires_at<now()');
    await c.query(
      "UPDATE device_logs SET raw_data=NULL WHERE id IN (SELECT id FROM device_logs WHERE raw_data IS NOT NULL AND received_at<now()-interval '7 days' LIMIT 1000)",
    );
    await c.query(
      "DELETE FROM realtime_outbox WHERE id IN(SELECT id FROM realtime_outbox WHERE dispatched_at<now()-interval '1 day' LIMIT 1000)",
    );
    await c.query(
      "DELETE FROM device_logs WHERE id IN(SELECT l.id FROM device_logs l WHERE l.received_at<now()-interval '30 days' AND NOT EXISTS(SELECT 1 FROM realtime_outbox o WHERE o.log_id=l.id AND o.dispatched_at IS NULL) LIMIT 1000)",
    );
    await c.query(
      "DELETE FROM gps_points WHERE id IN(SELECT id FROM gps_points WHERE received_at<now()-interval '90 days' LIMIT 1000)",
    );
    await c.query(
      "DELETE FROM ingestion_receipts WHERE event_id IN(SELECT r.event_id FROM ingestion_receipts r WHERE r.received_at<now()-interval '90 days' AND NOT EXISTS(SELECT 1 FROM device_logs l WHERE l.event_id=r.event_id) AND NOT EXISTS(SELECT 1 FROM gps_points p WHERE p.event_id=r.event_id) LIMIT 1000)",
    );
  });
}
export function startJobs(pool: pg.Pool, config: Config) {
  let stopped = false;
  let running: Promise<void> | undefined;
  let ticks = 0;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = (async () => {
      await dispatchOutbox(pool, config);
      if (++ticks % 60 === 0) await retention(pool);
    })()
      .catch((err) => logger.error({ err }, 'Background job failed'))
      .finally(() => {
        running = undefined;
      });
  }, 1000);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
