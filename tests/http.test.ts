import { createBackend } from '../services/backend/src/bootstrap.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import type { AddressInfo } from 'node:net';
import { createApp } from '../services/backend/src/app.js';
import { readConfig } from '../services/backend/src/config/env.js';

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
  const server = createApp(createBackend(pool, config), config).listen(0, '127.0.0.1');

  await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    let response = await fetch(`${origin}/login`);

    assert.equal(response.status, 200);
    const loginHtml = await response.text();

    assert.match(loginHtml, /Welcome back/);
    assert.match(loginHtml, /<script\s+src="\/assets\/login\.js"\s+type="module"\s*>/);
    assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    // Check both service-local assets and the root dependency after directory moves.
    response = await fetch(`${origin}/assets/style.css`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/css/);
    response = await fetch(`${origin}/assets/socket.io/socket.io.min.js`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Socket.IO/);
    for (const module of ['common', 'login', 'vehicles', 'logs']) {
      response = await fetch(`${origin}/assets/${module}.js`);
      assert.equal(response.status, 200, `Compiled browser module: ${module}`);
      assert.match(response.headers.get('content-type')!, /javascript/);
      assert.doesNotMatch(await response.text(), /import type|interface Window/);
    }

    response = await fetch(`${origin}/assets/common.ts`);
    assert.equal(response.status, 404, 'TypeScript source must not be served');
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
