import type { Config } from '../services/backend/src/config/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { createIngestion } from '../services/backend/src/bootstrap.js';
import { event } from './fixtures.js';

const url = process.env.DATABASE_TEST_URL;

test(
  'PostGIS transaction, replay, historical state and tenant assignment integrity',
  { skip: !url },
  async () => {
    const schema = `fleet_test_${randomBytes(6).toString('hex')}`;
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
      const otherOrg = randomUUID();
      const vehicle = randomUUID();
      const device = randomUUID();

      await pool.query("INSERT INTO organizations(id,name) VALUES($1,'A'),($2,'B')", [
        org,
        otherOrg,
      ]);
      await pool.query(
        "INSERT INTO vehicles(id,organization_id,name,registration_number,registration_key,vehicle_type) VALUES($1,$2,'Van','GJ01','GJ01','van')",
        [vehicle, org],
      );
      await pool.query(
        "INSERT INTO devices(id,organization_id,imei,manufacturer,model,protocol,profile_id,expected_interval) VALUES($1,$2,'358980100675496','Concox','Test','CONCOX','concox-v29-standard',10)",
        [device, org],
      );
      await pool.query(
        "INSERT INTO vehicle_device_assignments(id,organization_id,device_id,vehicle_id,valid_from) VALUES($1,$2,$3,$4,now()-interval '1 day')",
        [randomUUID(), org, device, vehicle],
      );
      const e = event();
      const cfg = { ALLOW_UNVERIFIED_MARKON: 'false' as const };

      e.trace = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
      assert.equal((await ingest(pool, e, cfg)).duplicate, false);
      const persistedTrace = (
        await pool.query(
          'SELECT ingestion_event_id,trace_id,span_id FROM realtime_outbox WHERE ingestion_event_id=$1',
          [e.eventId],
        )
      ).rows[0];

      assert.equal(persistedTrace.ingestion_event_id, e.eventId);
      assert.equal(persistedTrace.trace_id, e.trace.traceId);
      assert.match(persistedTrace.span_id, /^[a-f0-9]{16}$/);
      assert.equal((await ingest(pool, e, cfg)).duplicate, true);
      assert.equal((await ingest(pool, { ...e, eventId: randomUUID() }, cfg)).duplicate, true);
      const old = {
        ...e,
        eventId: randomUUID(),
        deviceTimestamp: new Date(Date.now() - 60000).toISOString(),
        historical: true,
        source: { ...e.source, sequence: '44' },
        location: { ...e.location!, latitude: 24 },
        status: { ignition: false, gpsValid: true },
      };

      await ingest(pool, old, cfg);
      let rows = (
        await pool.query(
          'SELECT ST_Y(position) AS latitude,ignition FROM vehicle_latest_state WHERE vehicle_id=$1',
          [vehicle],
        )
      ).rows;

      assert.equal(rows[0].latitude, 23.0225);
      assert.equal(rows[0].ignition, true);
      assert.equal((await pool.query('SELECT count(*) FROM gps_points')).rows[0].count, '2');
      assert.equal((await pool.query('SELECT count(*) FROM realtime_outbox')).rows[0].count, '2');
      const invalid = { ...e, eventId: randomUUID(), deviceIdentifier: '123456789012345' };

      await assert.rejects(() => ingest(pool, invalid, cfg));
      assert.equal(
        (await pool.query('SELECT count(*) FROM ingestion_receipts')).rows[0].count,
        '2',
      );
      await assert.rejects(() =>
        pool.query(
          'INSERT INTO vehicle_device_assignments(id,organization_id,device_id,vehicle_id,valid_from) VALUES($1,$2,$3,$4,now())',
          [randomUUID(), otherOrg, device, vehicle],
        ),
      );
      rows = (await pool.query('SELECT id FROM device_logs WHERE organization_id=$1', [otherOrg]))
        .rows;
      assert.equal(rows.length, 0);
    } finally {
      await pool.end();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
    }
  },
);

function ingest(pool: pg.Pool, input: unknown, config: Pick<Config, 'ALLOW_UNVERIFIED_MARKON'>) {
  return createIngestion(pool, config).ingest(input);
}
