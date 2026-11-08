import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { transaction } from '../services/backend/src/database/transaction.js';
import { outboxRepository } from '../services/backend/src/modules/outbox/outbox.repository.js';
import { retainRecords } from '../services/backend/src/modules/maintenance/retention.repository.js';
import { createOutboxJob } from '../services/backend/src/jobs/outbox.job.js';

const url = process.env.DATABASE_TEST_URL;

test(
  'PostGIS outbox leases, lost completion retries and pending-log retention',
  { skip: !url },
  async () => {
    const schema = `fleet_outbox_${randomBytes(6).toString('hex')}`;
    const setup = new pg.Pool({ connectionString: url });

    await setup.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await setup.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    await setup.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public` });

    try {
      await pool.query(
        await readFile(
          new URL('../services/backend/migrations/001_initial.sql', import.meta.url),
          'utf8',
        ),
      );
      await pool.query(
        await readFile(
          new URL('../services/backend/migrations/002_outbox_tracing.sql', import.meta.url),
          'utf8',
        ),
      );
      const org = randomUUID();
      const device = randomUUID();
      const ids = [randomUUID(), randomUUID()];

      for (const id of ids) {
        await pool.query(
          'INSERT INTO realtime_outbox(id,organization_id,device_id,log_id) VALUES($1,$2,$3,$4)',
          [id, org, device, randomUUID()],
        );
      }

      const claims = await Promise.all([
        transaction(pool, (c) => outboxRepository(c).claim()),
        transaction(pool, (c) => outboxRepository(c).claim()),
      ]);

      assert.equal(claims.flat().length, 2);
      assert.equal(new Set(claims.flat().map((row) => row.id)).size, 2);
      const store = outboxRepository(pool);
      const first = ids[0]!;

      assert.equal((await transaction(pool, (c) => outboxRepository(c).claim())).length, 0);
      await store.retry(first);
      const retry = (
        await pool.query(
          'SELECT attempts,lease_until,next_attempt_at>now() AS delayed FROM realtime_outbox WHERE id=$1',
          [first],
        )
      ).rows[0];

      assert.equal(retry.attempts, 1);
      assert.equal(retry.lease_until, null);
      assert.equal(retry.delayed, true);
      await pool.query(
        "UPDATE realtime_outbox SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
        [first],
      );
      let notifications = 0;
      let loseCompletion = true;
      const job = createOutboxJob({
        store: {
          claim: () => transaction(pool, (c) => outboxRepository(c).claim()),
          retry: store.retry,
          delivered: async (id) => {
            if (loseCompletion) {
              loseCompletion = false;
              throw new Error('Lost completion');
            }

            await store.delivered(id);
          },
        },
        send: async () => {
          notifications++;
        },
        warn: () => {},
      });

      await job();
      assert.equal(notifications, 1);
      assert.equal(
        (await pool.query('SELECT dispatched_at FROM realtime_outbox WHERE id=$1', [first])).rows[0]
          .dispatched_at,
        null,
      );
      await pool.query(
        "UPDATE realtime_outbox SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
        [first],
      );
      await job();
      assert.equal(notifications, 2);
      assert(
        (await pool.query('SELECT dispatched_at FROM realtime_outbox WHERE id=$1', [first])).rows[0]
          .dispatched_at,
      );

      await pool.query("INSERT INTO organizations(id,name) VALUES($1,'QA')", [org]);
      await pool.query(
        "INSERT INTO devices(id,organization_id,imei,manufacturer,model,protocol,profile_id,expected_interval) VALUES($1,$2,'123456789012345','Concox','QA','CONCOX','concox-v29-standard',60)",
        [device, org],
      );
      const logIds = [randomUUID(), randomUUID()];

      for (const logId of logIds) {
        const eventId = randomUUID();

        await pool.query(
          "INSERT INTO ingestion_receipts(event_id,organization_id,device_id,fingerprint,received_at) VALUES($1,$2,$3,$4,now()-interval '31 days')",
          [eventId, org, device, logId],
        );
        await pool.query(
          "INSERT INTO device_logs(id,event_id,organization_id,device_id,received_at,protocol,packet_type,event_type,decode_status,checksum_status,normalized_data,raw_data,parser_version,historical) VALUES($1,$2,$3,$4,now()-interval '31 days','CONCOX','13','HEARTBEAT','DECODED','VALID','{}','private','1',false)",
          [logId, eventId, org, device],
        );
      }

      await pool.query(
        'INSERT INTO realtime_outbox(id,organization_id,device_id,log_id) VALUES($1,$2,$3,$4)',
        [randomUUID(), org, device, logIds[0]],
      );
      const orphan = randomUUID();

      await pool.query(
        "INSERT INTO ingestion_receipts(event_id,organization_id,device_id,fingerprint,received_at) VALUES($1,$2,$3,$4,now()-interval '91 days')",
        [orphan, org, device, orphan],
      );
      await transaction(pool, retainRecords);
      const protectedLog = (
        await pool.query('SELECT raw_data FROM device_logs WHERE id=$1', [logIds[0]])
      ).rows;

      assert.equal(protectedLog.length, 1);
      assert.equal(protectedLog[0].raw_data, null);
      assert.equal(
        (await pool.query('SELECT id FROM device_logs WHERE id=$1', [logIds[1]])).rowCount,
        0,
      );
      assert.equal(
        (await pool.query('SELECT event_id FROM ingestion_receipts WHERE event_id=$1', [orphan]))
          .rowCount,
        0,
      );
    } finally {
      await pool.end();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
    }
  },
);
