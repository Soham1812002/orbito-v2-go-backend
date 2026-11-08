import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '../shared/logging/logger.js';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { requestId } from '../shared/http/request-id.js';
import { serviceAuth } from '../shared/http/service-auth.js';
import { createOutboxJob } from '../services/backend/src/jobs/outbox.job.js';
import type { RealtimeEvent } from '../shared/contracts/identity.js';
import { logContext, newTrace, parseTraceparent, traceparent } from '../shared/logging/context.js';

test('logging isolates concurrent traces, keeps every level and excludes unsafe fields and errors', async () => {
  const lines: string[] = [];
  const logger = createLogger('test', {
    write: (line: string) => {
      lines.push(line);
    },
  });
  const contexts = [newTrace(), newTrace()];

  await Promise.all(
    contexts.map((context, index) =>
      logContext.run(context, async () => {
        await delay(index === 0 ? 10 : 1);
        logger.trace(
          { event: 'test.trace', password: 'secret-value', nested: { raw: 'raw-payload' } },
          'Trace record',
        );
        logger.debug({ event: 'test.debug' }, 'Debug record');
        logger.info({ event: 'test.info' }, 'Info record');
        logger.warn({ event: 'test.warn', outcome: 'retry' }, 'Retry record');
        logger.error(
          { event: 'test.error', err: new Error('credential-secret'), outcome: 'failure' },
          'Operation failed',
        );
        logger.fatal({ event: 'test.fatal', outcome: 'failure' }, 'Fatal record');
      }),
    ),
  );
  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.equal(records.length, 12);
  assert.deepEqual(
    new Set(records.map((r) => r.level)),
    new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  );
  assert.equal(records.filter((r) => r.traceId === contexts[0]!.traceId).length, 6);
  assert.equal(records.filter((r) => r.traceId === contexts[1]!.traceId).length, 6);
  assert(!lines.join('').includes('secret-value'));
  assert(!lines.join('').includes('raw-payload'));
  assert(!lines.join('').includes('credential-secret'));
  assert.equal(records.find((r) => r.level === 'error')?.errorType, 'Error');
  assert.equal(logContext.getStore(), undefined);
});

test('trace headers reject zero identifiers, unsupported versions and oversized input', () => {
  const context = newTrace();

  assert.deepEqual(parseTraceparent(traceparent(context)), context);
  assert.equal(parseTraceparent(`00-${'0'.repeat(32)}-${context.spanId}-01`), undefined);
  assert.equal(parseTraceparent(`00-${context.traceId}-${'0'.repeat(16)}-01`), undefined);
  assert.equal(parseTraceparent(`ff-${context.traceId}-${context.spanId}-01`), undefined);
  assert.equal(parseTraceparent('x'.repeat(10000)), undefined);
});

test('public trace headers are ignored and authenticated internal requests inherit a child span', async () => {
  const app = express();
  const parent = newTrace();

  app.use(requestId);
  app.get('/public', (_req, res) => {
    res.json(logContext.getStore());
  });
  app.get('/internal', serviceAuth('secret'), (_req, res) => {
    res.json(logContext.getStore());
  });
  const server = app.listen(0, '127.0.0.1');

  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const external = await fetch(`${base}/public`, {
      headers: { traceparent: traceparent(parent) },
    });
    const externalBody = (await external.json()) as Record<string, unknown>;

    assert.notEqual(externalBody.traceId, parent.traceId);
    assert.equal(external.headers.get('x-trace-id'), externalBody.traceId);
    const denied = await fetch(`${base}/internal`, {
      headers: { traceparent: traceparent(parent) },
    });

    assert.equal(denied.status, 401);
    assert.notEqual(denied.headers.get('x-trace-id'), parent.traceId);
    const internal = await fetch(`${base}/internal`, {
      headers: { traceparent: traceparent(parent), authorization: 'Bearer secret' },
    });
    const body = (await internal.json()) as Record<string, unknown>;

    assert.equal(body.traceId, parent.traceId);
    assert.notEqual(body.spanId, parent.spanId);
    assert.equal(internal.headers.get('x-trace-id'), parent.traceId);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

test('outbox retries restore the original trace and packet ID with distinct delivery spans', async () => {
  const original = newTrace();
  const sent: RealtimeEvent[] = [];
  let retries = 0;
  const row = {
    id: 'delivery',
    organization_id: 'org',
    device_id: 'device',
    log_id: 'log',
    ingestion_event_id: 'packet',
    trace_id: original.traceId,
    span_id: original.spanId,
  };
  const options = {
    store: {
      claim: async () => [row],
      delivered: async () => {},
      retry: async () => {
        retries++;
      },
    },
    send: async (event: RealtimeEvent) => {
      sent.push(event);
      if (sent.length === 1) {
        throw new Error('offline');
      }
    },
    warn: () => {},
  };

  await createOutboxJob(options)();
  await createOutboxJob(options)();
  assert.equal(retries, 1);
  assert.equal(sent[0]?.ingestionEventId, 'packet');
  assert.equal(sent[1]?.ingestionEventId, 'packet');
  assert.equal(sent[0]?.trace?.traceId, original.traceId);
  assert.equal(sent[1]?.trace?.traceId, original.traceId);
  assert.notEqual(sent[0]?.trace?.spanId, sent[1]?.trace?.spanId);
  assert.equal(logContext.getStore(), undefined);
});
