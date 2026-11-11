import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { writeFile, readFile, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { io } from 'socket.io-client';
import { hashPassword } from '../../services/backend/src/modules/auth/passwords.js';
import { login, packet, type ExpectedPacket } from './protocol.js';
import { tracker, ACK_TIMEOUT_MS } from './tcp-client.js';

type Client = Awaited<ReturnType<typeof tracker>>;
type Expected = { packet: ExpectedPacket; count: number };

export async function runWorkload() {
  assert.equal(
    process.env.FLEET_LOAD_TEST,
    'isolated',
    'Use the Docker orchestrator, never a live deployment',
  );
  const api = 'http://backend:3000';
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });
  const directory = '/results';
  const maxDevices = Number(process.env.LOAD_DEVICES ?? 50);
  const rounds = Number(process.env.LOAD_ROUNDS ?? 3);

  assert(Number.isInteger(maxDevices) && maxDevices >= 1 && maxDevices <= 256);
  assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 100);
  const expected = new Map<string, Expected>();
  const confirmed = new Map<string, number>();
  const duplicates = new Map<string, number>();
  let replay: ReturnType<typeof packet> | undefined;
  const allClients = new Set<Client>();
  const devices: { imei: string; id: string; vehicleId: string }[] = [];
  const stages: unknown[] = [];
  let cookie = '';
  let csrf = '';
  const org = randomUUID();
  let liveNotifications = 0;
  let socket: ReturnType<typeof io> | undefined;
  let phase = 0;
  const report: Record<string, unknown> = {
    passed: false,
    stages,
    maxDevices,
    rounds,
    workload:
      'TCP Concox login/heartbeat/location/voltage/alarm; documented layouts, synthetic current UTC/serials',
  };

  async function request(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(api + path, {
      method,
      signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', origin: api, cookie, 'x-csrf-token': csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    assert(response.ok, `HTTP ${method} ${path.split('?')[0]}: ${response.status}`);

    return response;
  }

  async function control(action: string) {
    const id = randomUUID();

    await writeFile(`${directory}/control.tmp`, JSON.stringify({ id, action }));
    await rename(`${directory}/control.tmp`, `${directory}/control.json`);
    const deadline = Date.now() + 45000;

    while (Date.now() < deadline) {
      try {
        const response = JSON.parse(await readFile(`${directory}/control-done.json`, 'utf8')) as {
          id: string;
          error?: string;
        };

        if (response.id === id) {
          assert(!response.error, response.error);

          return;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
          throw error;
        }
      }

      await delay(200);
    }

    throw new Error(`Fault control timeout: ${action}`);
  }

  function remember(imei: string, value: ExpectedPacket) {
    const key = `${imei}:${value.rawHash}`;
    const current = expected.get(key);

    if (current) {
      current.count++;
    } else {
      expected.set(key, { packet: value, count: 1 });
    }
  }

  function confirm(imei: string, packet: ExpectedPacket) {
    const key = `${imei}:${packet.rawHash}`;

    confirmed.set(key, (confirmed.get(key) ?? 0) + 1);
  }

  function attempted() {
    return [...expected.values()].reduce((sum, entry) => sum + entry.count, 0);
  }

  function count() {
    return attempted() - [...duplicates.values()].reduce((sum, value) => sum + value, 0);
  }

  async function open(device: { imei: string }) {
    const client = await tracker('gateway');

    allClients.add(client);
    const bytes = login(device.imei);

    remember(device.imei, {
      type: '0x01',
      rawHash: createHash('sha256').update(bytes).digest('hex'),
      eventType: 'LOGIN',
      location: null,
      status: {},
    });
    try {
      await client.write(bytes);
      await client.ack(1, 1);
      confirm(
        device.imei,
        expected.get(`${device.imei}:${createHash('sha256').update(bytes).digest('hex')}`)!.packet,
      );

      return client;
    } catch (error) {
      client.destroy();
      throw error;
    }
  }

  async function send(
    client: Client,
    imei: string,
    round: number,
    samples: number[],
    heartbeatSamples?: number[],
  ) {
    const serial = 2 + phase * 500 + round * 4;
    const types = [0x13, 0x22, 0x94, 0x26];
    const frames = types.map((type, index) => packet(type, serial + index, new Date()));

    replay ??= frames[1];

    for (const entry of frames) {
      remember(imei, entry.expected);
    }

    const bytes = Buffer.concat(frames.map((entry) => entry.bytes));
    const started = performance.now();

    if (phase === 1 && round === 0) {
      // Exercise real split reads on the small first phase; larger phases use coalesced frames.
      await client.write(bytes.subarray(0, 7));
      await delay(5);
      await client.write(bytes.subarray(7));
    } else {
      await client.write(bytes);
    }

    await client.ack(0x13, serial, started + ACK_TIMEOUT_MS);
    heartbeatSamples?.push(performance.now() - started);
    confirm(imei, frames[0]!.expected);
    await client.ack(0x26, serial + 3, started + ACK_TIMEOUT_MS);
    for (const item of frames.slice(1)) {
      confirm(imei, item.expected);
    }

    samples.push(performance.now() - started);
  }

  async function drain() {
    const target = count();
    const deadline = Date.now() + 180000;

    while (Date.now() < deadline) {
      try {
        const rows = await pool.query<{ count: string }>(
          'SELECT count(*) FROM device_logs WHERE organization_id=$1',
          [org],
        );
        const ready = await fetch('http://gateway:8081/health/ready', {
          signal: AbortSignal.timeout(5000),
        });
        const health = (await ready.json()) as { spool: { pending: number; quarantined: number } };

        if (Number(rows.rows[0]!.count) === target && health.spool.pending === 0) {
          assert.equal(health.spool.quarantined, 0);

          return;
        }

        assert(Number(rows.rows[0]!.count) <= target, 'Unexpected extra database records');
      } catch (error) {
        if (error instanceof assert.AssertionError) {
          throw error;
        }

        report.monitoringRetries = Number(report.monitoringRetries ?? 0) + 1;
      }

      await delay(500);
    }

    throw new Error(`Database/spool did not reconcile ${target} packets within 180s`);
  }

  async function runStage(amount: number, paced = false) {
    phase++;
    const clients: Client[] = [];
    const samples: number[] = [];
    const heartbeatSamples: number[] = [];
    const before = count();

    try {
      for (let offset = 0; offset < amount; offset += 16) {
        const batch = await Promise.all(
          devices.slice(offset, Math.min(offset + 16, amount)).map(open),
        );

        clients.push(...batch);
      }

      if (amount === 256) {
        const beforeCapacity = (await (await fetch('http://gateway:8081/health/ready')).json()) as {
          capacityRejected: number;
        };
        let rejected = 0;

        for (let attempt = 0; attempt < 4; attempt++) {
          let extra: Client | undefined;

          try {
            extra = await tracker('gateway', 3000);
            await extra.write(login('990000000999999'));
            await extra.ack(1, 1);
          } catch {
            rejected++;
          } finally {
            extra?.destroy();
          }
        }

        assert.equal(rejected, 4, 'Connections above the configured 256 cap were not rejected');
        const afterCapacity = (await (await fetch('http://gateway:8081/health/ready')).json()) as {
          capacityRejected: number;
        };

        assert.equal(
          afterCapacity.capacityRejected - beforeCapacity.capacityRejected,
          4,
          'Failures were not attributable to the connection cap',
        );
        report.overCapacityRejected = rejected;
      }

      const started = performance.now();

      await Promise.all(
        clients.map(async (client, index) => {
          for (let round = 0; round < rounds; round++) {
            await send(client, devices[index]!.imei, round, samples, heartbeatSamples);
            if (paced) {
              await delay(1000);
            }
          }

          client.close();
        }),
      );
      const admissionSeconds = (performance.now() - started) / 1000;
      const admitted = amount * rounds * 4;
      const waitStarted = performance.now();

      await drain();
      samples.sort((a, b) => a - b);
      heartbeatSamples.sort((a, b) => a - b);
      const percentile = (fraction: number) =>
        Math.round(
          samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))]! * 100,
        ) / 100;
      const stage = {
        devices: amount,
        mode: paced ? 'four-frame-batches-with-1s-pause' : 'burst',
        frames: count() - before,
        payloadFrames: admitted,
        admissionSeconds,
        payloadFramesPerSecond: admitted / admissionSeconds,
        finalDrainSeconds: (performance.now() - waitStarted) / 1000,
        heartbeatAckMs: {
          p95: heartbeatSamples[
            Math.min(heartbeatSamples.length - 1, Math.floor(heartbeatSamples.length * 0.95))
          ],
          max: heartbeatSamples.at(-1),
        },
        fourFrameBatchAckMs: {
          p50: percentile(0.5),
          p95: percentile(0.95),
          p99: percentile(0.99),
          max: percentile(1),
        },
      };

      stages.push(stage);
      console.log(JSON.stringify(stage));
    } finally {
      for (const client of clients) {
        client.destroy();
      }
    }
  }

  try {
    const password = randomBytes(24).toString('hex');
    const email = `${org}@load.test`;

    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [
      org,
      'Isolated gateway load test',
    ]);
    await pool.query(
      "INSERT INTO users(id,organization_id,email,password_hash,role) VALUES($1,$2,$3,$4,'admin')",
      [randomUUID(), org, email, await hashPassword(password)],
    );
    const response = await request('/login', 'POST', { email, password });

    cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const html = await (await request('/vehicles')).text();

    csrf = html.match(/name="csrf-token"\s+content="([a-f0-9]+)"/)![1]!;
    for (let index = 0; index < maxDevices; index++) {
      const imei = `99${String(index).padStart(13, '0')}`;
      const registered = (await (
        await request('/api/v1/vehicles', 'POST', {
          name: `Load ${index}`,
          registrationNumber: `LOAD-${index}`,
          imei,
          profileId: 'concox-v29-standard',
          model: 'Documented synthetic fixture',
          firmware: 'simulated',
          vehicleType: 'van',
          expectedInterval: 10,
          enabled: true,
        })
      ).json()) as { deviceId: string; vehicleId: string };

      devices.push({ imei, id: registered.deviceId, vehicleId: registered.vehicleId });
    }

    // Wire timestamps have second precision: make them later than assignment creation.
    await delay(1100);
    const ticket = (await (await request('/api/v1/realtime-ticket', 'POST', {})).json()) as {
      ticket: string;
    };

    socket = io('http://realtime:3001', {
      autoConnect: false,
      reconnection: false,
      transports: ['websocket'],
      extraHeaders: { origin: api },
      auth: { ticket: ticket.ticket },
    });
    socket.on('device:log', () => {
      liveNotifications++;
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket authentication timeout')), 15000);

      socket!.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket!.once('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket!.connect();
    });
    for (const amount of [
      ...new Set([1, 10, 50, 128, maxDevices].filter((size) => size <= maxDevices)),
    ]) {
      await runStage(amount);
    }

    await runStage(Math.min(50, maxDevices), true);
    // Replay an identical timestamped GPS packet: transport admission repeats, business storage deduplicates.
    assert(replay);
    const repeated = await open(devices[0]!);
    const replayKey = `${devices[0]!.imei}:${replay.expected.rawHash}`;

    remember(devices[0]!.imei, replay.expected);
    duplicates.set(replayKey, 1);
    const barrier = packet(0x13, 60000, new Date());

    remember(devices[0]!.imei, barrier.expected);
    const replayStarted = performance.now();

    await repeated.write(Buffer.concat([replay.bytes, barrier.bytes]));
    await repeated.ack(0x13, 60000, replayStarted + ACK_TIMEOUT_MS);
    confirm(devices[0]!.imei, replay.expected);
    confirm(devices[0]!.imei, barrier.expected);
    repeated.close();
    await drain();
    report.wireRetransmissionDeduplicated = true;
    // ACKed backlog survives gateway SIGKILL, with the backend unavailable.
    phase++;
    const recoveryClients = await Promise.all(devices.slice(0, Math.min(10, maxDevices)).map(open));
    const beforeRecovery = count();

    try {
      await control('pause-backend');
      await Promise.all(
        recoveryClients.map(async (client, index) => {
          for (let round = 0; round < 4; round++) {
            await send(client, devices[index]!.imei, round, []);
          }
        }),
      );
      const health = (await (await fetch('http://gateway:8081/health/ready')).json()) as {
        spool: { pending: number };
      };

      assert(health.spool.pending > 0, 'Outage did not build a durable backlog');
      await control('restart-gateway');
      await control('resume-backend');
      await drain();
      report.recovery = {
        passed: true,
        backendPaused: true,
        gatewayKilled: true,
        payloadFrames: count() - beforeRecovery,
      };
    } finally {
      for (const client of recoveryClients) {
        client.destroy();
      }
    }

    const rows = await pool.query(
      'SELECT d.imei,l.id,l.vehicle_id,l.normalized_data,l.parser_version,l.raw_data FROM device_logs l JOIN devices d ON d.id=l.device_id WHERE l.organization_id=$1',
      [org],
    );
    const actual = new Map<string, number>();
    let positionCount = 0;

    for (const row of rows.rows) {
      const event = row.normalized_data as {
        packetType: string;
        eventType: string;
        location: ExpectedPacket['location'];
        status: ExpectedPacket['status'];
        source: { rawSha256: string };
        validation: { decodeStatus: string; checksum: string };
      };
      const key = `${row.imei}:${event.source.rawSha256}`;
      const want = expected.get(key);

      assert(want, 'Stored packet missing from sender manifest');
      actual.set(key, (actual.get(key) ?? 0) + 1);
      assert.equal(event.packetType, want.packet.type);
      assert.equal(event.eventType, want.packet.eventType);
      assert.equal(event.validation.decodeStatus, 'DECODED');
      assert.equal(event.validation.checksum, 'VALID');
      assert.equal(row.parser_version, '2');
      assert.equal(typeof row.raw_data, 'string');
      assert.equal(
        createHash('sha256')
          .update(Buffer.from(row.raw_data as string, 'hex'))
          .digest('hex'),
        event.source.rawSha256,
        'Stored raw bytes changed',
      );
      assert.equal(row.vehicle_id, devices.find((device) => device.imei === row.imei)!.vehicleId);
      if (want.packet.location) {
        positionCount++;
        assert(event.location);
        for (const field of ['latitude', 'longitude', 'speedKph', 'headingDegrees'] as const) {
          assert(
            Math.abs(event.location[field] - want.packet.location[field]) < 1e-9,
            `Converted ${field} mismatch`,
          );
        }
      } else {
        assert.equal(event.location, null);
      }

      for (const [key, value] of Object.entries(want.packet.status)) {
        assert.equal(event.status[key], value, `Converted status ${key} mismatch`);
      }
    }

    for (const [key, value] of expected) {
      assert.equal(
        actual.get(key),
        value.count - (duplicates.get(key) ?? 0),
        'Missing or duplicate durable observation',
      );
    }

    const points = await pool.query<{ count: string; aligned: boolean }>(
      `SELECT count(*) AS count,bool_and(abs(ST_X(p.position)-(l.normalized_data #>> '{location,longitude}')::float8)<1e-9 AND abs(ST_Y(p.position)-(l.normalized_data #>> '{location,latitude}')::float8)<1e-9) AS aligned FROM gps_points p JOIN device_logs l USING(event_id) WHERE p.organization_id=$1`,
      [org],
    );

    assert.equal(Number(points.rows[0]!.count), positionCount);
    assert.equal(points.rows[0]!.aligned, true);
    for (const type of ['0x01', '0x13', '0x22', '0x26', '0x94']) {
      const logs = (await (
        await request(`/api/v1/device-logs?packetType=${encodeURIComponent(type)}&limit=10`)
      ).json()) as {
        items: { packet_type: string; status: Record<string, unknown>; location: unknown }[];
      };

      assert(logs.items.length > 0 && logs.items.every((row) => row.packet_type === type));
      if (type === '0x94') {
        assert(
          logs.items.every(
            (row) => row.status.externalPowerVoltage === 11.83 && row.location === null,
          ),
        );
      }
    }

    const pagedIds = new Set<string>();
    let cursor: string | null = null;

    do {
      const query = new URLSearchParams({ limit: String(maxDevices <= 10 ? 7 : 200) });

      if (cursor) {
        query.set('cursor', cursor);
      }

      const page = (await (await request(`/api/v1/device-logs?${query}`)).json()) as {
        items: { id: string }[];
        nextCursor: string | null;
      };

      for (const row of page.items) {
        assert(!pagedIds.has(row.id), 'REST pagination repeated a packet');
        pagedIds.add(row.id);
      }

      cursor = page.nextCursor;
    } while (cursor);

    assert.equal(pagedIds.size, rows.rowCount, 'REST pagination skipped a persisted packet');
    report.fullRestPagination = true;
    assert(liveNotifications > 0, 'No committed notification reached the authenticated socket');
    const pendingCount = async () =>
      Number(
        (
          await pool.query<{ count: string }>(
            'SELECT count(*) FROM realtime_outbox WHERE organization_id=$1 AND dispatched_at IS NULL',
            [org],
          )
        ).rows[0]!.count,
      );

    report.pendingNotificationsAtDataDrain = await pendingCount();
    const notificationStarted = performance.now();
    const notificationDeadline = notificationStarted + 300000;
    let pendingNotifications = Number(report.pendingNotificationsAtDataDrain);

    while (pendingNotifications > 0 && performance.now() < notificationDeadline) {
      await delay(1000);
      pendingNotifications = await pendingCount();
    }

    report.notificationDrainSeconds = (performance.now() - notificationStarted) / 1000;
    assert.equal(
      pendingNotifications,
      0,
      'Notifications did not drain within five minutes after traffic stopped',
    );

    Object.assign(report, {
      passed: true,
      expectedFrames: count(),
      storedFrames: rows.rowCount,
      points: positionCount,
      decodedFieldValidation: true,
      postgisAxisValidation: true,
      restValidation: true,
      liveNotifications,
      pendingNotifications,
      missingFrames: 0,
      unexpectedFrames: 0,
    });
  } catch (error) {
    for (const client of allClients) {
      client.destroy();
    }

    try {
      const health = (await (
        await fetch('http://gateway:8081/health/ready', { signal: AbortSignal.timeout(5000) })
      ).json()) as { spool: { pending: number; quarantined: number } };
      const snapshot = await pool.query(
        "SELECT d.imei,l.normalized_data #>> '{source,rawSha256}' AS hash FROM device_logs l JOIN devices d ON d.id=l.device_id WHERE l.organization_id=$1",
        [org],
      );
      const stored = new Map<string, number>();

      for (const row of snapshot.rows) {
        const key = `${row.imei}:${row.hash}`;

        stored.set(key, (stored.get(key) ?? 0) + 1);
      }

      let confirmedNotInDatabase = 0;

      for (const [key, value] of confirmed) {
        confirmedNotInDatabase += Math.max(0, value - (stored.get(key) ?? 0));
      }

      report.failureSnapshot = {
        storedFrames: snapshot.rowCount,
        pendingSpool: health.spool.pending,
        quarantined: health.spool.quarantined,
        confirmedNotInDatabase,
        interpretation:
          health.spool.pending > 0
            ? 'Pending records remain; this snapshot is not a packet-loss conclusion'
            : 'Spool drained at the snapshot',
      };
    } catch {
      report.failureSnapshot = 'Unavailable; inspect retained logs and spool snapshot';
    }

    report.error = error instanceof Error ? error.message : 'Load test failed';
    throw error;
  } finally {
    socket?.disconnect();
    for (const client of allClients) {
      client.destroy();
    }

    report.attemptedFrames = attempted();
    report.confirmedAdmissions = [...confirmed.values()].reduce((sum, value) => sum + value, 0);
    await writeFile(
      `${directory}/manifest.json`,
      JSON.stringify({
        attempted: [...expected].map(([key, value]) => ({ key, count: value.count })),
        confirmed: [...confirmed],
        duplicates: [...duplicates],
      }),
    );
    await pool.end();
    await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  }
}
