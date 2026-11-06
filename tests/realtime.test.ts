import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import { createRealtime } from '../apps/realtime-server/src/app.js';

test('socket ticket authentication and organization fanout remain separate', async () => {
  const org = randomUUID(),
    otherOrg = randomUUID(),
    secret = 's'.repeat(32);
  let used = false;
  const api = express();
  api.use(express.json());
  api.post('/internal/realtime/v1/realtime-tickets/consume', (req, res) => {
    if (
      req.headers.authorization !== `Bearer ${secret}` ||
      req.body.ticket !== 'a'.repeat(64) ||
      used
    ) {
      res.sendStatus(401);
      return;
    }
    used = true;
    res.json({ id: 'user', organization_id: org, session_hash: 'b'.repeat(64) });
  });
  api.post('/internal/realtime/v1/subscriptions/authorize', (_req, res) => {
    res.json({ id: 'user', organization_id: org });
  });
  const authServer = api.listen(0, '127.0.0.1');
  await new Promise<void>((r) => authServer.once('listening', r));
  const realtime = createRealtime({
    apiUrl: `http://127.0.0.1:${(authServer.address() as AddressInfo).port}`,
    secret,
    origin: 'http://fleet.test',
  });
  realtime.server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => realtime.server.once('listening', r));
  const address = `http://127.0.0.1:${(realtime.server.address() as AddressInfo).port}`;
  const client = io(address, {
    auth: { ticket: 'a'.repeat(64) },
    // Match the browser's initial same-origin polling request (no Origin header).
    reconnection: false,
    autoConnect: false,
  });
  const invalidClient = io(address, {
    auth: { ticket: 'invalid' },
    reconnection: false,
    autoConnect: false,
    timeout: 2000,
  });
  try {
    const foreignOrigin = await fetch(`${address}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: 'http://other.test' },
    });
    assert.equal(foreignOrigin.status, 403);
    const rejected = new Promise<Error>((resolve) => invalidClient.once('connect_error', resolve));
    invalidClient.connect();
    assert.equal((await rejected).message, 'Unauthorized');
    invalidClient.close();
    const connected = new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('connect_error', reject);
    });
    client.connect();
    await connected;
    const payload = {
      eventId: randomUUID(),
      organizationId: otherOrg,
      deviceId: randomUUID(),
      logId: randomUUID(),
    };
    let delivered = 0;
    client.on('device:log', () => delivered++);
    let response = await fetch(`${address}/internal/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 401);
    response = await fetch(`${address}/internal/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);
    assert.equal(delivered, 0);
    const received = new Promise<any>((resolve) => client.once('device:log', resolve));
    response = await fetch(`${address}/internal/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ ...payload, organizationId: org }),
    });
    assert.equal(response.status, 200);
    const event = await received;
    assert.equal(event.logId, payload.logId);
    assert.equal(event.organizationId, undefined);
  } finally {
    invalidClient.close();
    client.close();
    await realtime.io.close();
    await new Promise<void>((r) => authServer.close(() => r()));
  }
});
