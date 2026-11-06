import test from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import type { AddressInfo } from 'node:net';
import { createApp } from '../apps/backend-api/src/app.js';
import { readConfig } from '../apps/backend-api/src/config.js';
const config = readConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://unused',
  GATEWAY_SECRET: 'a'.repeat(32),
  REALTIME_SECRET: 'b'.repeat(32),
});
test('anonymous requests and internal endpoints are protected; login is server rendered', async () => {
  const pool = {
    query: async () => {
      throw new Error('Unexpected database access');
    },
  } as unknown as pg.Pool;
  const server = createApp(pool, config).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    let response = await fetch(`${origin}/login`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Welcome back/);
    assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    response = await fetch(`${origin}/api/v1/vehicles`);
    assert.equal(response.status, 401);
    response = await fetch(`${origin}/internal/v1/device-registry`);
    assert.equal(response.status, 401);
    response = await fetch(`${origin}/internal/realtime/v1/subscriptions/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 401);
    response = await fetch(`${origin}/vehicles`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
