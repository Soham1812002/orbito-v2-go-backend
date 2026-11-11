import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createVehicleService } from '../services/backend/src/modules/vehicles/vehicles.service.js';
import { createAssignmentService } from '../services/backend/src/modules/assignments/assignments.service.js';
import { createLogService } from '../services/backend/src/modules/device-logs/logs.service.js';
import { createAuthService } from '../services/backend/src/modules/auth/auth.service.js';
import { createOutboxJob } from '../services/backend/src/jobs/outbox.job.js';
import { startJobs } from '../services/backend/src/jobs/scheduler.js';
import { createFanoutService } from '../services/realtime/src/services/fanout.service.js';
import { vehicleInput } from '../shared/contracts/fleet.js';
import { ApplicationError } from '../shared/errors/application-error.js';
import type { FleetTransactionRunner } from '../services/backend/src/modules/fleet/fleet.ports.js';

const actor = { id: 'actor', organization_id: 'organization', role: 'admin' as const };

test('service authorization and assignment clock checks run without HTTP or persistence', async () => {
  let transactions = 0;
  const inTransaction: FleetTransactionRunner = async () => {
    transactions++;
    throw new Error('Must not access persistence');
  };

  const service = createVehicleService({
    read: { list: async () => [] },
    inTransaction,
    newId: () => 'id',
  });

  await assert.rejects(
    () =>
      service.register(
        { ...actor, role: 'viewer' },
        vehicleInput.parse({
          name: 'Van',
          registrationNumber: 'QA',
          imei: '123456789012345',
          profileId: 'concox-v29-standard',
          model: 'QA',
        }),
      ),
    (error: unknown) => error instanceof ApplicationError && error.code === 'forbidden',
  );
  const assignment = createAssignmentService({
    inTransaction,
    newId: () => 'id',
    now: () => Date.parse('2026-11-08T00:00:00Z'),
  });

  await assert.rejects(
    () =>
      assignment.replace(actor, 'vehicle', {
        deviceId: 'device',
        effectiveAt: '2026-11-07T00:00:00Z',
      }),
    (error: unknown) => error instanceof ApplicationError && error.code === 'invalid_input',
  );
  assert.equal(transactions, 0);
});

test('log policy enforces scope and range; viewer redaction does not mutate repository data', async () => {
  const record = { raw_data: 'private', normalized_data: { event: 'QA' } };
  const calls: string[] = [];
  const service = createLogService(
    {
      list: async () => {
        throw new Error('Must validate range first');
      },
      detail: async (org) => {
        calls.push(org);

        return record;
      },
    },
    () => Date.parse('2026-11-08T00:00:00Z'),
  );
  const viewer = await service.detail({ ...actor, role: 'viewer' }, 'log');

  assert.equal('raw_data' in viewer, false);
  assert.equal((await service.detail(actor, 'log')).raw_data, 'private');
  assert.equal(record.raw_data, 'private');
  assert.deepEqual(calls, [actor.organization_id, actor.organization_id]);
  await assert.rejects(
    () =>
      service.list(actor, { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z', limit: 50 }),
    (error: unknown) => error instanceof ApplicationError && error.code === 'invalid_input',
  );
});

test('unknown-account login still pays the password-verification cost', async () => {
  let verified = false;
  const service = createAuthService({
    repository: {
      findUser: async () => undefined,
      activeSession: async () => undefined,
      createSession: async () => {
        throw new Error('Must not create a session');
      },
      deleteSession: async () => {},
    },
    verifyPassword: async (_password, stored) => {
      verified = true;
      assert.match(stored, /^scrypt-32768-8-3\$/);

      return false;
    },
    newToken: () => {
      throw new Error('Must not create tokens');
    },
    tokenHash: () => '',
    sessionHours: 12,
  });

  await assert.rejects(
    () => service.login({ email: 'missing@example.test', password: 'password' }),
    (error: unknown) => error instanceof ApplicationError && error.code === 'unauthorized',
  );
  assert.equal(verified, true);
});

test('outbox retries delivery/completion failures and continues other claimed events', async () => {
  const events = [
    {
      id: 'first',
      lease_token: 'first-lease',
      organization_id: 'org',
      device_id: 'device',
      log_id: 'log',
    },
    {
      id: 'second',
      lease_token: 'second-lease',
      organization_id: 'org',
      device_id: 'device',
      log_id: 'log',
    },
  ];
  const completed: string[] = [];
  const retried: string[] = [];
  const sent: string[] = [];
  const dispatch = createOutboxJob({
    store: {
      claim: async () => events,
      renew: async () => true,
      delivered: async (id) => {
        completed.push(id);
      },
      retry: async (id) => {
        retried.push(id);
      },
    },
    send: async (event) => {
      sent.push(event.eventId);
      if (event.eventId === 'first') {
        throw new Error('Delivery unavailable');
      }
    },
    warn: () => {},
  });

  await dispatch();
  assert.deepEqual(sent, ['first', 'second']);
  assert.deepEqual(retried, ['first']);
  assert.deepEqual(completed, ['second']);
});

test('scheduler stop drains an active job and prevents overlapping work', async () => {
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const stop = startJobs({
    dispatch: async () => {
      calls++;
      started();
      await gate;
    },
    retain: async () => {},
    error: () => {},
    intervalMs: 1,
  });

  await entered;
  let drained = false;
  const stopping = stop().then(() => {
    drained = true;
  });

  await setImmediate();
  assert.equal(drained, false);
  release();
  await stopping;
  assert.equal(calls, 1);
  assert.equal(drained, true);
});

test('fanout revalidates each connection and disconnects unauthorized or unavailable identities', async () => {
  const notified: string[] = [];
  const disconnected: string[] = [];
  const connections = ['valid', 'foreign', 'revoked'].map((id) => ({
    identity: { id, organization_id: 'org', role: 'viewer' as const, session_hash: id },
    disconnect: () => {
      disconnected.push(id);
    },
    notify: () => {
      notified.push(id);
    },
  }));
  const fanout = createFanoutService({
    connections: async () => connections,
    authorize: async (hash) => {
      if (hash === 'revoked') {
        throw new Error('Session revoked');
      }

      return { id: hash, organization_id: hash === 'foreign' ? 'other' : 'org', role: 'viewer' };
    },
  });

  await fanout({ eventId: 'event', organizationId: 'org', deviceId: 'device', logId: 'log' });
  assert.deepEqual(notified, ['valid']);
  assert.deepEqual(disconnected.sort(), ['foreign', 'revoked']);
});

test('retention runs independently while notification dispatch is blocked', async () => {
  let release!: () => void;
  let started!: () => void;
  let retained!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const retention = new Promise<void>((resolve) => {
    retained = resolve;
  });
  const stop = startJobs({
    dispatch: async () => {
      started();
      await gate;
    },
    retain: async () => {
      retained();
    },
    error: () => {},
    intervalMs: 1,
    retentionIntervalMs: 5,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      (async () => {
        await entered;
        await retention;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Retention waited for blocked dispatch')), 1000);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }

    release();
    await stop();
  }
});

test('fanout bounds authorization work and shares only within one event', async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  let notified = 0;
  const fanout = createFanoutService({
    connections: async () =>
      Array.from({ length: 40 }, (_, i) => ({
        identity: {
          id: `u${i % 20}`,
          organization_id: 'org',
          role: 'viewer' as const,
          session_hash: `s${i % 20}`,
        },
        disconnect: () => {},
        notify: () => {
          notified++;
        },
      })),
    authorize: async (hash) => {
      calls++;
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;

      return { id: hash, organization_id: 'org', role: 'viewer' as const };
    },
  });
  const event = { eventId: 'event', organizationId: 'org', deviceId: 'device', logId: 'log' };

  await fanout(event);
  assert.equal(calls, 20);
  assert.equal(notified, 40);
  assert(maximum <= 8);
  await fanout(event);
  assert.equal(calls, 40, 'Authorization cache escaped a single event');
});
