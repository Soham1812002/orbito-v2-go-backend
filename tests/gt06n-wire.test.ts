import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { createServer as createHTTPServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../services/backend/src/app.js';
import { createBackend } from '../services/backend/src/bootstrap.js';
import { readConfig } from '../services/backend/src/config/env.js';
import { vehicleInput } from '../shared/contracts/fleet.js';
import { decodedEvent } from '../shared/contracts/events.js';
import { frame, login, packet } from '../utils/stress/protocol.js';
import { tracker } from '../utils/stress/tcp-client.js';

const url = process.env.DATABASE_TEST_URL;
const binary = process.env.GATEWAY_TEST_BINARY;
const profile = 'concox-gt06n-v1';

async function unusedPort() {
  const server = createServer();

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  await new Promise<void>((resolve) => server.close(() => resolve()));

  return port;
}

async function eventually(check: () => Promise<boolean>, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) {
      return;
    }

    await delay(100);
  }

  assert.fail(message);
}

test(
  'GT06N TCP demo packets persist correct output, preserve profile/tenant isolation and do not rewind state',
  {
    skip: !url || !binary ? 'Set DATABASE_TEST_URL and GATEWAY_TEST_BINARY for wire QA' : false,
    timeout: 60000,
  },
  async (t) => {
    const schema = `gt06n_wire_${randomBytes(6).toString('hex')}`;
    const setup = new pg.Pool({ connectionString: url });

    await setup.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await setup.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    await setup.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public` });
    const spool = await mkdtemp(join(tmpdir(), 'fleet-gt06n-'));
    let child: ChildProcess | undefined;
    let gatewayLog = '';

    async function stopGateway(signal: NodeJS.Signals = 'SIGTERM') {
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      const exited = once(child, 'exit');

      child.kill(signal);
      const timer = setTimeout(() => child?.kill('SIGKILL'), 5000);

      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }

    const config = readConfig({
      NODE_ENV: 'test',
      DATABASE_URL: url,
      GATEWAY_SECRET: randomBytes(32).toString('hex'),
      REALTIME_SECRET: randomBytes(32).toString('hex'),
    });
    const backend = createBackend(pool, config);
    let blockForward = false;
    const app = createApp(backend, config);
    const server = createHTTPServer((req, res) => {
      if (blockForward && req.url === '/internal/v1/events') {
        res.writeHead(503).end();

        return;
      }

      app(req, res);
    }).listen(0, '127.0.0.1');

    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    t.after(async () => {
      await stopGateway();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
      await rm(spool, { recursive: true, force: true });
    });
    const migrations = new URL('../services/backend/migrations/', import.meta.url);

    for (const file of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    }

    const actor = { id: randomUUID(), organization_id: randomUUID(), role: 'admin' as const };
    const outsider = { ...actor, id: randomUUID(), organization_id: randomUUID() };

    await pool.query("INSERT INTO organizations(id,name) VALUES($1,'GT06N QA'),($2,'Foreign QA')", [
      actor.organization_id,
      outsider.organization_id,
    ]);
    await pool.query(
      "INSERT INTO users(id,organization_id,email,password_hash,role) VALUES($1,$2,'gt06n@example.test','unused','admin')",
      [actor.id, actor.organization_id],
    );
    const registered = await backend.vehicles.register(
      actor,
      vehicleInput.parse({
        name: 'GT06N demo',
        registrationNumber: 'DEMO-GT06',
        imei: '123456789012345',
        profileId: profile,
        model: 'GT06N',
      }),
    );

    await backend.vehicles.register(
      actor,
      vehicleInput.parse({
        name: 'Legacy demo',
        registrationNumber: 'DEMO-V29',
        imei: '752533678900242',
        profileId: 'concox-v29-standard',
        model: 'Standard QA',
      }),
    );
    await pool.query(
      "UPDATE vehicle_device_assignments SET valid_from='2010-01-01' WHERE device_id=$1",
      [registered.deviceId],
    );
    const vectors = JSON.parse(
      await readFile(
        new URL('../services/gateway/internal/protocol/testdata/gt06n.json', import.meta.url),
        'utf8',
      ),
    ) as Record<string, string>;
    const bytes = (key: string) => Buffer.from(vectors[key]!, 'hex');
    const logCount = async () =>
      Number(
        (
          await pool.query('SELECT count(*) FROM device_logs WHERE device_id=$1', [
            registered.deviceId,
          ])
        ).rows[0].count,
      );

    async function startGateway(offset: string) {
      const [port, markonPort, controlPort] = await Promise.all([
        unusedPort(),
        unusedPort(),
        unusedPort(),
      ]);

      child = spawn(resolve(binary!), [], {
        env: {
          ...process.env,
          API_URL: origin,
          GATEWAY_SECRET: config.GATEWAY_SECRET,
          SPOOL_DIR: spool,
          CONCOX_ADDR: `127.0.0.1:${port}`,
          MARKON_ADDR: `127.0.0.1:${markonPort}`,
          CONTROL_ADDR: `127.0.0.1:${controlPort}`,
          GT06N_UTC_OFFSET_MINUTES: offset,
          LOG_LEVEL: 'error',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.on('error', (error) => {
        gatewayLog += error.message;
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on('data', (chunk: Buffer) => {
          gatewayLog = (gatewayLog + chunk.toString()).slice(-10000);
        });
      }

      await eventually(async () => {
        if (child?.exitCode !== null) {
          assert.fail(`Gateway exited: ${gatewayLog}`);
        }

        try {
          return (await fetch(`http://127.0.0.1:${controlPort}/health/ready`)).ok;
        } catch {
          return false;
        }
      }, `Gateway not ready: ${gatewayLog}`);

      return { port, controlPort };
    }

    async function waitDrained(controlPort: number, count: number) {
      await eventually(async () => {
        const health = (await (
          await fetch(`http://127.0.0.1:${controlPort}/health/ready`)
        ).json()) as { spool: { pending: number; quarantined: number } };

        assert.equal(health.spool.quarantined, 0, gatewayLog);

        return health.spool.pending === 0 && (await logCount()) === count;
      }, `Spool/database did not drain to ${count}: ${gatewayLog}`);
    }

    const unknown = await startGateway('');
    const device = await tracker('127.0.0.1', 5000, unknown.port);

    t.after(() => device.destroy());
    await device.write(bytes('login').subarray(0, 7));
    await device.write(bytes('login').subarray(7));
    await device.ack(1, 1);
    await device.write(Buffer.concat([bytes('location'), bytes('alarm'), bytes('heartbeat')]));
    await device.ack(0x16, 0x36);
    await device.ack(0x13, 5);
    await waitDrained(unknown.controlPort, 4);
    const uncertain = (
      await pool.query(
        'SELECT normalized_data FROM device_logs WHERE device_id=$1 AND packet_type=$2',
        [registered.deviceId, '0x12'],
      )
    ).rows[0].normalized_data;

    assert.equal(uncertain.deviceTimestamp, null);
    assert.equal(uncertain.protocolData.timestampQuality, 'UNVERIFIED_TIMEZONE');
    assert.equal(uncertain.status.ignition, undefined);
    assert.equal(Number((await pool.query('SELECT count(*) FROM gps_points')).rows[0].count), 0);
    device.destroy();
    await stopGateway();

    const verified = await startGateway('0');
    const connected = await tracker('127.0.0.1', 5000, verified.port);

    t.after(() => connected.destroy());
    await connected.write(bytes('login'));
    await connected.ack(1, 1);
    const recentBody = Buffer.from(bytes('location').subarray(4, -6));
    const recentTime = new Date(Math.floor(Date.now() / 1000) * 1000 - 2000);

    Buffer.from([
      recentTime.getUTCFullYear() - 2000,
      recentTime.getUTCMonth() + 1,
      recentTime.getUTCDate(),
      recentTime.getUTCHours(),
      recentTime.getUTCMinutes(),
      recentTime.getUTCSeconds(),
    ]).copy(recentBody);
    recentBody.writeUInt16BE(0xd400, 16); // valid ACC ON, valid north/east fix
    const recent = frame(0x12, 10, recentBody);
    const oldBody = Buffer.from(recentBody);
    const older = new Date(recentTime.getTime() - 60000);

    Buffer.from([
      older.getUTCFullYear() - 2000,
      older.getUTCMonth() + 1,
      older.getUTCDate(),
      older.getUTCHours(),
      older.getUTCMinutes(),
      older.getUTCSeconds(),
    ]).copy(oldBody);
    oldBody.writeUInt32BE(1800000, 7);
    oldBody.writeUInt16BE(0x5400, 16); // valid ACC OFF
    const corrupt = Buffer.from(recent);

    corrupt[corrupt.length - 4] = corrupt[corrupt.length - 4]! ^ 1;
    const malformed = Buffer.from(recentBody);

    malformed[1] = 13;
    const mileage = Buffer.alloc(4);

    mileage.writeUInt32BE(123456);
    await connected.write(
      Buffer.concat([
        bytes('location'),
        bytes('alarm'),
        recent,
        recent,
        frame(0x12, 11, oldBody),
        corrupt,
        frame(0x22, 12, Buffer.alloc(29)),
        frame(0x12, 13, malformed),
        frame(0x12, 14, Buffer.concat([recentBody, mileage])),
        bytes('heartbeat'),
      ]),
    );
    await connected.ack(0x16, 0x36);
    await connected.ack(0x13, 5);
    await waitDrained(verified.controlPort, 14);
    const logs = (
      await pool.query('SELECT * FROM device_logs WHERE device_id=$1 ORDER BY received_at,id', [
        registered.deviceId,
      ])
    ).rows;

    for (const log of logs) {
      assert.equal(decodedEvent.parse(log.normalized_data).profile, profile);
      assert.equal(
        createHash('sha256').update(Buffer.from(log.raw_data, 'hex')).digest('hex'),
        log.normalized_data.source.rawSha256,
      );
    }

    assert.equal(
      logs.find((log) => log.normalized_data.source.sequence === '14')!.normalized_data.protocolData
        .mileageRaw,
      123456,
    );

    const recentHash = createHash('sha256').update(recent).digest('hex');

    assert.equal(
      logs.filter((log) => log.normalized_data.source.rawSha256 === recentHash).length,
      1,
      'Timestamped wire retransmission was not deduplicated',
    );
    const location = logs.find(
      (log) => log.normalized_data.source.rawSha256 === recentHash,
    )!.normalized_data;

    assert.equal(location.deviceTimestamp, recentTime.toISOString().replace('.000Z', 'Z'));
    assert.equal(location.status.ignition, true);
    assert.equal(location.location.latitude, 0x027ac7eb / 1800000);
    assert.equal(location.location.longitude, 0x0c465849 / 1800000);
    assert.equal(location.source.raw, undefined);
    const latest = (
      await pool.query(
        'SELECT ST_Y(position) AS lat, ST_X(position) AS lon, location_time, ignition FROM vehicle_latest_state WHERE vehicle_id=$1',
        [registered.vehicleId],
      )
    ).rows[0];

    assert.equal(latest.lat, location.location.latitude);
    assert.equal(latest.lon, location.location.longitude);
    assert.equal(latest.location_time.toISOString(), recentTime.toISOString());
    // The later heartbeat legitimately updates ignition at receive time; old GPS must not rewind position.
    assert.equal(latest.ignition, false);
    assert.equal(logs.filter((log) => log.decode_status === 'INVALID_CHECKSUM').length, 1);
    assert.equal(logs.filter((log) => log.decode_status === 'MALFORMED').length, 1);
    assert.equal(logs.filter((log) => log.decode_status === 'UNSUPPORTED').length, 1);
    assert.equal(
      Number(
        (
          await pool.query('SELECT count(*) FROM gps_points WHERE device_id=$1', [
            registered.deviceId,
          ])
        ).rows[0].count,
      ),
      5,
    );
    const foreignLogs = await backend.logs.list(outsider, { limit: 50 });

    assert.equal(foreignLogs.items.length, 0);
    await assert.rejects(() => backend.logs.detail(outsider, logs[0].id));
    assert.equal(
      'raw_data' in (await backend.logs.detail({ ...actor, role: 'viewer' }, logs[0].id)),
      false,
    );
    assert.equal((await backend.logs.detail(actor, logs[0].id)).raw_data, logs[0].raw_data);
    assert.equal(
      Number(
        (
          await pool.query('SELECT count(*) FROM realtime_outbox WHERE device_id=$1', [
            registered.deviceId,
          ])
        ).rows[0].count,
      ),
      14,
    );

    const legacy = await tracker('127.0.0.1', 5000, verified.port);

    t.after(() => legacy.destroy());
    await legacy.write(login('752533678900242'));
    await legacy.ack(1, 1);
    await legacy.write(
      Buffer.concat([packet(0x22, 20, recentTime).bytes, packet(0x13, 21, recentTime).bytes]),
    );
    await legacy.ack(0x13, 21);
    await eventually(
      async () =>
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM device_logs WHERE normalized_data->>'profile'='concox-v29-standard'",
            )
          ).rows[0].count,
        ) === 3,
      'Legacy profile stopped persisting',
    );

    blockForward = true;
    await connected.write(frame(0x13, 80, Buffer.from('4401040001', 'hex')));
    await connected.ack(0x13, 80); // Local durable admission succeeds during a backend outage.
    await eventually(
      async () => (await readdir(spool)).filter((name) => name.endsWith('.json')).length === 1,
      'ACKed heartbeat missing from spool',
    );
    assert.equal(await logCount(), 14);
    const pendingName = (await readdir(spool)).find((name) => name.endsWith('.json'))!;
    const pending = decodedEvent.parse(
      JSON.parse(await readFile(join(spool, pendingName), 'utf8')),
    );

    assert.equal(pending.packetType, '0x13');
    await stopGateway('SIGKILL');
    blockForward = false;
    const recovered = await startGateway('0');

    await waitDrained(recovered.controlPort, 15);
    const recoveredLog = (
      await pool.query('SELECT normalized_data FROM device_logs WHERE event_id=$1', [
        pending.eventId,
      ])
    ).rows;

    assert.equal(recoveredLog.length, 1);
    assert.equal(recoveredLog[0].normalized_data.source.rawSha256, pending.source.rawSha256);
    assert.equal(
      Number(
        (
          await pool.query('SELECT count(*) FROM realtime_outbox WHERE device_id=$1', [
            registered.deviceId,
          ])
        ).rows[0].count,
      ),
      15,
    );
    t.diagnostic(
      JSON.stringify({
        gt06nLogs: 15,
        gpsPoints: 5,
        legacyLogs: 3,
        duplicateLocations: 1,
        crashRecoveredEvents: 1,
        latitude: location.location.latitude,
        longitude: location.location.longitude,
        ignition: location.status.ignition,
        timestamp: location.deviceTimestamp,
        unknownTimezone: uncertain.protocolData.timestampQuality,
        pendingSpool: 0,
        quarantined: 0,
      }),
    );
  },
);
