import type { Config } from '../services/backend/src/config/env.js';
import { createBackend } from '../services/backend/src/bootstrap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { createApp } from '../services/backend/src/app.js';
import { readConfig } from '../services/backend/src/config/env.js';
import { hashPassword } from '../services/backend/src/modules/auth/passwords.js';
import { createIngestion } from '../services/backend/src/bootstrap.js';
import { event } from './fixtures.js';

const url = process.env.DATABASE_TEST_URL;

test(
  'fleet HTTP transactions, permissions, tickets and raw-data access',
  { skip: !url },
  async (t) => {
    const schema = `fleet_http_${randomBytes(6).toString('hex')}`;
    const setup = new pg.Pool({ connectionString: url });

    await setup.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await setup.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    await setup.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public` });
    const config = readConfig({
      NODE_ENV: 'test',
      DATABASE_URL: url,
      GATEWAY_SECRET: 'a'.repeat(32),
      REALTIME_SECRET: 'b'.repeat(32),
      PUBLIC_ORIGIN: 'http://fleet.test',
    });
    const server = createApp(createBackend(pool, config), config).listen(0, '127.0.0.1');

    await new Promise<void>((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      await pool.query(
        await readFile(
          new URL('../services/backend/migrations/001_initial.sql', import.meta.url),
          'utf8',
        ),
      );
      const org = randomUUID();
      const foreignOrg = randomUUID();
      const password = 'integration-test-password';
      const hash = await hashPassword(password);

      await pool.query("INSERT INTO organizations(id,name) VALUES($1,'QA'),($2,'Foreign')", [
        org,
        foreignOrg,
      ]);

      async function login(role: string, organizationId: string) {
        const id = randomUUID();
        const email = `${id}@example.test`;

        await pool.query(
          'INSERT INTO users(id,organization_id,email,password_hash,role) VALUES($1,$2,$3,$4,$5)',
          [id, organizationId, email, hash, role],
        );
        const response = await fetch(`${origin}/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: config.PUBLIC_ORIGIN },
          body: JSON.stringify({ email, password }),
        });

        assert.equal(response.status, 200);
        const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
        const { rows } = await pool.query<{ csrf_token: string }>(
          'SELECT csrf_token FROM sessions WHERE user_id=$1',
          [id],
        );

        return { cookie, csrf: rows[0]!.csrf_token, id };
      }

      const admin = await login('admin', org);
      const viewer = await login('viewer', org);
      const outsider = await login('admin', foreignOrg);

      async function request(path: string, method = 'GET', body?: unknown, actor = admin) {
        return fetch(origin + path, {
          method,
          headers: {
            cookie: actor.cookie,
            origin: config.PUBLIC_ORIGIN,
            'x-csrf-token': actor.csrf,
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      }

      let sequence = 0;
      const input = () => ({
        name: 'QA Van',
        registrationNumber: `QA-${++sequence}`,
        imei: `35898010067${String(sequence).padStart(4, '0')}`,
        profileId: 'concox-v29-standard',
        model: 'QA Tracker',
        vehicleType: 'van',
        expectedInterval: 60,
        enabled: true,
      });
      const first = input();
      const created = await request('/api/v1/vehicles', 'POST', first);

      assert.equal(created.status, 201);
      const registered = (await created.json()) as { vehicleId: string; deviceId: string };

      await t.test(
        'registration commits related records and concurrent uniqueness leaves no orphan device',
        async () => {
          for (const table of ['vehicles', 'devices', 'vehicle_device_assignments', 'audit_logs']) {
            assert.equal(
              (await pool.query(`SELECT count(*)::int AS total FROM ${table}`)).rows[0].total,
              1,
            );
          }

          const duplicate = input();

          duplicate.registrationNumber = first.registrationNumber;
          const results = await Promise.all([
            request('/api/v1/vehicles', 'POST', duplicate),
            request('/api/v1/vehicles', 'POST', { ...duplicate, imei: input().imei }),
          ]);

          assert.deepEqual(
            results.map((r) => r.status),
            [409, 409],
          );
          assert.equal(
            (await pool.query('SELECT count(*)::int AS total FROM devices')).rows[0].total,
            1,
          );
          const race = input();
          const racing = await Promise.all([
            request('/api/v1/vehicles', 'POST', race),
            request('/api/v1/vehicles', 'POST', { ...race, imei: input().imei }),
          ]);

          assert.deepEqual(racing.map((r) => r.status).sort(), [201, 409]);
          assert.equal(
            (await pool.query('SELECT count(*)::int AS total FROM devices')).rows[0].total,
            2,
          );
        },
      );
      await t.test('audit failure rolls back registration and replacement effects', async () => {
        await pool.query(
          `CREATE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced audit failure'; END $$`,
        );
        await pool.query(
          'CREATE TRIGGER reject_test_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_test_audit()',
        );
        const failed = input();

        assert.equal((await request('/api/v1/vehicles', 'POST', failed)).status, 500);
        assert.equal(
          (await pool.query('SELECT id FROM devices WHERE imei=$1', [failed.imei])).rowCount,
          0,
        );
        const replacement = input();

        assert.equal(
          (
            await request(`/api/v1/vehicles/${registered.vehicleId}/device-assignment`, 'POST', {
              device: replacement,
              effectiveAt: new Date().toISOString(),
            })
          ).status,
          422,
        );
        const { imei, model, profileId, expectedInterval } = replacement;

        assert.equal(
          (
            await request(`/api/v1/vehicles/${registered.vehicleId}/device-assignment`, 'POST', {
              device: { imei, model, profileId, expectedInterval },
              effectiveAt: new Date().toISOString(),
            })
          ).status,
          500,
        );
        assert.equal(
          (
            await pool.query(
              'SELECT device_id FROM vehicle_device_assignments WHERE vehicle_id=$1 AND valid_to IS NULL',
              [registered.vehicleId],
            )
          ).rows[0].device_id,
          registered.deviceId,
        );
        assert.equal(
          (await pool.query('SELECT id FROM devices WHERE imei=$1', [replacement.imei])).rowCount,
          0,
        );
        await pool.query('DROP TRIGGER reject_test_audit ON audit_logs');
      });
      await t.test('role and tenant checks protect mutations and log raw data', async () => {
        assert.equal((await request('/api/v1/vehicles', 'POST', input(), viewer)).status, 403);
        assert.equal(
          (
            await request(
              `/api/v1/vehicles/${registered.vehicleId}`,
              'PATCH',
              { name: 'Forbidden' },
              outsider,
            )
          ).status,
          404,
        );
        await ingest(
          pool,
          {
            ...event(),
            deviceIdentifier: first.imei,
            source: { ...event().source, raw: 'QA RAW' },
          },
          { ALLOW_UNVERIFIED_MARKON: 'false' },
        );
        const logId = (
          await pool.query('SELECT id FROM device_logs WHERE device_id=$1', [registered.deviceId])
        ).rows[0].id as string;

        assert.equal(
          (await (await request(`/api/v1/device-logs/${logId}`)).json()).raw_data,
          'QA RAW',
        );
        assert.equal(
          'raw_data' in
            (await (
              await request(`/api/v1/device-logs/${logId}`, 'GET', undefined, viewer)
            ).json()),
          false,
        );
        assert.equal(
          (await request(`/api/v1/device-logs/${logId}`, 'GET', undefined, outsider)).status,
          404,
        );
      });
      await t.test(
        'replacement closes historical assignment and preserves old log ownership',
        async () => {
          const replacement = input();
          const { imei, model, profileId, expectedInterval } = replacement;
          const response = await request(
            `/api/v1/vehicles/${registered.vehicleId}/device-assignment`,
            'POST',
            {
              device: { imei, model, profileId, expectedInterval },
              effectiveAt: new Date().toISOString(),
            },
          );

          assert.equal(response.status, 200);
          const assignments = (
            await pool.query(
              'SELECT device_id,valid_to FROM vehicle_device_assignments WHERE vehicle_id=$1 ORDER BY valid_from',
              [registered.vehicleId],
            )
          ).rows;

          assert.equal(assignments.length, 2);
          assert(assignments[0].valid_to);
          assert.equal(assignments[1].valid_to, null);
          assert.notEqual(assignments[1].device_id, registered.deviceId);
          assert.equal(
            (
              await pool.query('SELECT vehicle_id FROM device_logs WHERE device_id=$1', [
                registered.deviceId,
              ])
            ).rows[0].vehicle_id,
            registered.vehicleId,
          );
        },
      );
      await t.test(
        'tickets are single-use under concurrency and revoked sessions are rejected',
        async () => {
          const issued = (await (await request('/api/v1/realtime-ticket', 'POST', {})).json()) as {
            ticket: string;
          };
          const consume = () =>
            fetch(`${origin}/internal/realtime/v1/realtime-tickets/consume`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${config.REALTIME_SECRET}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify(issued),
            });
          const responses = await Promise.all([consume(), consume()]);

          assert.deepEqual(responses.map((r) => r.status).sort(), [200, 401]);
          const identity = (await responses.find((r) => r.status === 200)!.json()) as {
            session_hash: string;
          };

          assert.equal((await request('/logout', 'POST', {})).status, 200);
          const revoked = await fetch(`${origin}/internal/realtime/v1/subscriptions/authorize`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${config.REALTIME_SECRET}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ sessionHash: identity.session_hash }),
          });

          assert.equal(revoked.status, 401);
        },
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
    }
  },
);

function ingest(pool: pg.Pool, input: unknown, config: Pick<Config, 'ALLOW_UNVERIFIED_MARKON'>) {
  return createIngestion(pool, config).ingest(input);
}
