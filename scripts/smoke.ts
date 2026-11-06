import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { io, type Socket } from 'socket.io-client';
import { z } from 'zod';
import { database, transaction } from '../apps/backend-api/src/db/index.js';
import { hashPassword } from '../apps/backend-api/src/modules/auth.js';
import type { DecodedEvent } from '../packages/contracts/src/index.js';

const env = z
  .object({
    NODE_ENV: z.literal('development'),
    FLEET_ALLOW_DEMO: z.literal('true'),
    DATABASE_URL: z.string().min(1),
    API_URL: z.string().url(),
    WEB_URL: z.string().url(),
    SOCKET_URL: z.string().url(),
    PUBLIC_ORIGIN: z.string().url(),
    GATEWAY_SECRET: z.string().min(32),
    DEMO_EMAIL: z.string().email(),
    DEMO_PASSWORD: z.string().min(12).max(256),
  })
  .parse(process.env);
const { pool } = database(env.DATABASE_URL);
const sessions: { cookie: string; csrf: string }[] = [];
const temporaryUsers: string[] = [];
const temporaryOrgs: string[] = [];
const checks: { check: string; status: 'PASS' }[] = [];
let socket: Socket | undefined;
const pass = (check: string) => {
  checks.push({ check, status: 'PASS' });
  console.log(`PASS ${check}`);
};

async function request(path: string, expected: number, options: RequestInit = {}) {
  const response = await fetch(
    new URL(
      path,
      path.startsWith('/internal/') || path.startsWith('/health/') ? env.API_URL : env.WEB_URL,
    ),
    {
      ...options,
      signal: AbortSignal.timeout(10000),
      headers: {
        'content-type': 'application/json',
        origin: env.PUBLIC_ORIGIN,
        ...options.headers,
      },
    },
  );
  // Do not include headers, cookies, passwords or entire request bodies in failures.
  assert.equal(
    response.status,
    expected,
    `${options.method ?? 'GET'} ${path}: expected ${expected}, received ${response.status}`,
  );
  return response;
}
async function login(email: string, password: string) {
  const response = await request('/login', 200, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert(cookie && cookie.startsWith('fleet_session='), 'Login did not issue a session cookie');
  const html = await (await request('/vehicles', 200, { headers: { cookie } })).text();
  const csrf = html.match(/name="csrf-token" content="([a-f0-9]+)"/)?.[1];
  assert(csrf, 'Vehicle page is missing its CSRF token');
  const session = { cookie, csrf };
  sessions.push(session);
  return session;
}
function auth(session: { cookie: string; csrf: string }) {
  return { cookie: session.cookie, 'x-csrf-token': session.csrf };
}
async function postEvent(event: DecodedEvent, expected = 200) {
  const response = await request('/internal/v1/events', expected, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.GATEWAY_SECRET}` },
    body: JSON.stringify(event),
  });
  return response.json();
}
async function createTemporaryUser(org: string, role: string) {
  const id = randomUUID(),
    password = randomBytes(24).toString('hex');
  const email = `smoke-${id}@example.test`;
  await pool.query(
    'INSERT INTO users(id,organization_id,email,password_hash,role) VALUES($1,$2,$3,$4,$5)',
    [id, org, email, await hashPassword(password), role],
  );
  temporaryUsers.push(id);
  return login(email, password);
}

try {
  const readyDeadline = Date.now() + 30000;
  while (true) {
    try {
      await request('/health/ready', 200);
      await request('/login', 200);
      break;
    } catch {
      if (Date.now() >= readyDeadline)
        throw new Error('API or Nginx did not become ready within 30 seconds');
      await delay(500);
    }
  }
  const blockedInternal = await fetch(new URL('/internal/v1/device-registry', env.WEB_URL), {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(blockedInternal.status, 404, 'Nginx must block private endpoints');
  pass('API readiness, Nginx login page and private-route isolation');
  await request('/api/v1/vehicles', 401);
  await request('/internal/v1/events', 401, { method: 'POST', body: '{}' });
  pass('Public and internal requests require authentication');

  const demoPasswordHash = await hashPassword(env.DEMO_PASSWORD);
  const org = await transaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('fleet-demo-setup'))");
    const existing = await c.query(
      'SELECT u.organization_id,u.role,o.name FROM users u JOIN organizations o ON o.id=u.organization_id WHERE u.email=$1',
      [env.DEMO_EMAIL.toLowerCase()],
    );
    if (existing.rows[0]) {
      assert.equal(
        existing.rows[0].name,
        'Fleet demo workspace',
        'Demo email belongs to an existing non-demo workspace',
      );
      assert.equal(existing.rows[0].role, 'admin', 'Demo user is not an administrator');
      return existing.rows[0].organization_id as string;
    }
    const id = randomUUID();
    await c.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [id, 'Fleet demo workspace']);
    await c.query(
      'INSERT INTO users(id,organization_id,email,password_hash,role) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), id, env.DEMO_EMAIL.toLowerCase(), demoPasswordHash, 'admin'],
    );
    return id;
  });
  const admin = await login(env.DEMO_EMAIL, env.DEMO_PASSWORD);
  pass('Demo administrator login and CSRF token');

  const suffix = randomBytes(5).toString('hex');
  const imei = `99${BigInt(`0x${randomBytes(6).toString('hex')}`)
    .toString()
    .padStart(13, '0')
    .slice(-13)}`;
  const vehicle = {
    name: `Demo delivery van ${suffix}`,
    registrationNumber: `DEMO-${suffix.toUpperCase()}`,
    imei,
    profileId: 'concox-v29-standard',
    model: 'API smoke fixture',
    firmware: 'simulated',
    vehicleType: 'van',
    notes:
      'Synthetic normalized API events. This does not validate a physical tracker or its wire parser.',
    expectedInterval: 10,
    enabled: true,
  };
  await request('/api/v1/vehicles', 403, {
    method: 'POST',
    headers: { cookie: admin.cookie },
    body: JSON.stringify(vehicle),
  });
  await request('/api/v1/vehicles', 422, {
    method: 'POST',
    headers: auth(admin),
    body: JSON.stringify({ ...vehicle, imei: '123' }),
  });
  await request('/api/v1/vehicles', 422, {
    method: 'POST',
    headers: auth(admin),
    body: JSON.stringify({ ...vehicle, organizationId: randomUUID() }),
  });
  const created = (await (
    await request('/api/v1/vehicles', 201, {
      method: 'POST',
      headers: auth(admin),
      body: JSON.stringify(vehicle),
    })
  ).json()) as { vehicleId: string; deviceId: string };
  assert(z.string().uuid().safeParse(created.deviceId).success);
  await request('/api/v1/vehicles', 409, {
    method: 'POST',
    headers: auth(admin),
    body: JSON.stringify(vehicle),
  });
  pass('Vehicle registration, CSRF, input validation and duplicate rejection');

  const registry = await (
    await request(`/internal/v1/device-registry?imei=${imei}`, 200, {
      headers: { authorization: `Bearer ${env.GATEWAY_SECRET}` },
    })
  ).json();
  assert.equal(registry.items[0].profile, vehicle.profileId);
  assert.equal(registry.items[0].enabled, true);
  pass('New device is available in the gateway registry');

  const ticket = await (
    await request('/api/v1/realtime-ticket', 200, {
      method: 'POST',
      headers: auth(admin),
      body: '{}',
    })
  ).json();
  const notices: { deviceId: string; logId: string }[] = [];
  socket = io(env.SOCKET_URL, {
    transports: ['websocket'],
    extraHeaders: { Origin: env.PUBLIC_ORIGIN },
    auth: { ticket: ticket.ticket },
    autoConnect: false,
    reconnection: false,
    timeout: 10000,
  });
  socket.on('device:log', (notice) => notices.push(notice));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket connection timed out')), 15000);
    socket!.once('connect', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket!.once('connect_error', () => {
      clearTimeout(timeout);
      reject(new Error('Socket authentication failed'));
    });
    socket!.connect();
  });
  pass('Authenticated Socket.IO connection');

  // Times stay after the assignment boundary, with the historical point older than the first live point.
  const start = Date.now();
  const event: DecodedEvent = {
    schemaVersion: 1,
    eventId: randomUUID(),
    deviceIdentifier: imei,
    protocol: 'CONCOX',
    profile: vehicle.profileId,
    packetType: '0x22',
    eventType: 'LOCATION',
    deviceTimestamp: new Date(start + 3000).toISOString(),
    receivedAt: new Date(start + 4000).toISOString(),
    historical: false,
    location: { latitude: 23.0225, longitude: 72.5714, speedKph: 45, headingDegrees: 120 },
    status: { ignition: true, gpsValid: true },
    validation: {
      decodeStatus: 'DECODED',
      checksum: 'VALID',
      warnings: ['Synthetic API fixture; CRC was not evaluated by the gateway'],
    },
    source: {
      sequence: '1',
      rawSha256: createHash('sha256').update(`api-smoke:${suffix}:location`).digest('hex'),
      sessionId: randomUUID(),
    },
    protocolData: { simulated: true, fixture: 'docker-api-smoke' },
  };
  const accepted = await postEvent(event);
  assert.equal(accepted.eventId, event.eventId);
  assert.equal(accepted.persisted, true);
  assert.equal(accepted.duplicate, false);
  assert.equal((await postEvent(event)).duplicate, true);
  assert.equal((await postEvent({ ...event, eventId: randomUUID() })).duplicate, true);
  pass('Location accepted after commit; retries and retransmissions deduplicated');

  const heartbeat: DecodedEvent = {
    ...event,
    eventId: randomUUID(),
    eventType: 'HEARTBEAT',
    packetType: '0x13',
    location: null,
    deviceTimestamp: null,
    receivedAt: new Date(start + 5000).toISOString(),
    status: { ignition: true, batteryLevel: 4, gsmLevel: 3 },
    source: {
      ...event.source,
      sequence: '2',
      rawSha256: createHash('sha256').update(`api-smoke:${suffix}:heartbeat`).digest('hex'),
    },
  };
  await postEvent(heartbeat);
  const historical: DecodedEvent = {
    ...event,
    eventId: randomUUID(),
    historical: true,
    deviceTimestamp: new Date(start + 1000).toISOString(),
    receivedAt: new Date(start + 6000).toISOString(),
    location: { ...event.location!, latitude: 24 },
    status: { ignition: false, gpsValid: true },
    source: {
      ...event.source,
      sequence: '3',
      rawSha256: createHash('sha256').update(`api-smoke:${suffix}:history`).digest('hex'),
    },
  };
  await postEvent(historical);
  const diagnostic: DecodedEvent = {
    ...event,
    eventId: randomUUID(),
    eventType: 'DIAGNOSTIC',
    deviceTimestamp: null,
    receivedAt: new Date(start + 7000).toISOString(),
    location: null,
    status: {},
    validation: {
      decodeStatus: 'INVALID_CHECKSUM',
      checksum: 'INVALID',
      warnings: ['Synthetic invalid CRC diagnostic'],
    },
    source: {
      ...event.source,
      sequence: '4',
      raw: '0000',
      rawSha256: createHash('sha256').update(`api-smoke:${suffix}:diagnostic`).digest('hex'),
    },
  };
  await postEvent(diagnostic);
  await postEvent(
    { ...event, eventId: randomUUID(), location: { ...event.location!, latitude: 91 } },
    422,
  );
  await postEvent({ ...event, eventId: randomUUID(), profile: 'concox-v29-eg02' }, 409);
  await postEvent({ ...event, eventId: randomUUID(), deviceIdentifier: '000000000000000' }, 409);
  pass(
    'Heartbeat, history and diagnostic accepted; invalid fields, profile and unknown device rejected',
  );

  const points = await pool.query(
    'SELECT count(*)::int AS count FROM gps_points WHERE device_id=$1',
    [created.deviceId],
  );
  const logs = await pool.query(
    'SELECT count(*)::int AS count FROM device_logs WHERE device_id=$1',
    [created.deviceId],
  );
  const receipts = await pool.query(
    'SELECT count(*)::int AS count FROM ingestion_receipts WHERE device_id=$1',
    [created.deviceId],
  );
  assert.equal(points.rows[0].count, 2);
  assert.equal(logs.rows[0].count, 4);
  assert.equal(receipts.rows[0].count, 4);
  const latest = await pool.query(
    'SELECT ST_Y(position) AS latitude,ignition FROM vehicle_latest_state WHERE vehicle_id=$1',
    [created.vehicleId],
  );
  assert.equal(latest.rows[0].latitude, event.location!.latitude);
  assert.equal(latest.rows[0].ignition, true);
  pass('Database counts match and delayed history did not rewind latest state');

  const query = `deviceId=${created.deviceId}&to=${encodeURIComponent(new Date(start + 10000).toISOString())}`;
  const list = await (
    await request(`/api/v1/device-logs?${query}&limit=1`, 200, { headers: auth(admin) })
  ).json();
  assert.equal(list.items.length, 1);
  assert(list.nextCursor);
  const next = await (
    await request(
      `/api/v1/device-logs?${query}&limit=1&cursor=${encodeURIComponent(list.nextCursor)}`,
      200,
      { headers: auth(admin) },
    )
  ).json();
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0].id, list.items[0].id);
  const detail = await (
    await request(`/api/v1/device-logs/${list.items[0].id}`, 200, { headers: auth(admin) })
  ).json();
  assert.equal(detail.normalized_data.protocolData.simulated, true);
  assert.equal(detail.raw_data, '0000');
  pass('Decoded log list, detail and cursor pagination');

  const otherOrg = randomUUID();
  await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [
    otherOrg,
    `Temporary smoke isolation ${suffix}`,
  ]);
  temporaryOrgs.push(otherOrg);
  const outsider = await createTemporaryUser(otherOrg, 'viewer');
  await request(`/api/v1/device-logs/${list.items[0].id}`, 404, { headers: auth(outsider) });
  const otherList = await (
    await request('/api/v1/vehicles', 200, { headers: auth(outsider) })
  ).json();
  assert.equal(otherList.items.length, 0);
  await request('/api/v1/vehicles', 403, {
    method: 'POST',
    headers: auth(outsider),
    body: JSON.stringify(vehicle),
  });
  const viewer = await createTemporaryUser(org, 'viewer');
  const redacted = await (
    await request(`/api/v1/device-logs/${list.items[0].id}`, 200, { headers: auth(viewer) })
  ).json();
  assert.equal(Object.hasOwn(redacted, 'raw_data'), false);
  pass('Tenant isolation, read-only role and raw-data redaction');

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const pending = await pool.query(
      'SELECT count(*)::int AS count FROM realtime_outbox WHERE device_id=$1 AND dispatched_at IS NULL',
      [created.deviceId],
    );
    if (!pending.rows[0].count && notices.some((n) => n.deviceId === created.deviceId)) break;
    await delay(100);
  }
  assert(
    notices.some((n) => n.deviceId === created.deviceId),
    'No saved-log notification arrived over Socket.IO',
  );
  const pending = await pool.query(
    'SELECT count(*)::int AS count FROM realtime_outbox WHERE device_id=$1 AND dispatched_at IS NULL',
    [created.deviceId],
  );
  assert.equal(pending.rows[0].count, 0, 'Outbox did not finish dispatching');
  pass('Committed events delivered through the outbox and Socket.IO');
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: checks.length,
        demoEmail: env.DEMO_EMAIL,
        vehicleId: created.vehicleId,
        deviceId: created.deviceId,
        imei,
        savedLogs: 4,
        savedPositions: 2,
      },
      null,
      2,
    ),
  );
  console.log(
    'Demo vehicle and messages remain available in the two pages. Password: .env DEMO_PASSWORD.',
  );
} finally {
  socket?.close();
  for (const session of sessions) {
    try {
      await request('/logout', 200, { method: 'POST', headers: auth(session), body: '{}' });
    } catch {
      /* Expiry/outage is covered by cleanup below. */
    }
  }
  for (const id of temporaryUsers) {
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    await pool.query('DELETE FROM users WHERE id=$1', [id]);
  }
  for (const id of temporaryOrgs) await pool.query('DELETE FROM organizations WHERE id=$1', [id]);
  await pool.end();
}
