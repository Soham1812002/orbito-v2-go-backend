import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { Config } from './config/env.js';
import type { BackendServices } from './application/backend.js';
import { checkDatabase } from './database/pool.js';
import { transaction } from './database/transaction.js';
import { vehicleReader, vehicleWriter } from './modules/vehicles/vehicles.repository.js';
import { deviceReader, deviceWriter } from './modules/devices/devices.repository.js';
import { assignmentRepository } from './modules/assignments/assignments.repository.js';
import { auditRepository } from './modules/audit/audit.repository.js';
import type { FleetTransactionRunner } from './modules/fleet/fleet.ports.js';
import { createVehicleService } from './modules/vehicles/vehicles.service.js';
import { createDeviceService } from './modules/devices/devices.service.js';
import { createAssignmentService } from './modules/assignments/assignments.service.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { authRepository } from './modules/auth/auth.repository.js';
import { verifyPassword } from './modules/auth/passwords.js';
import { randomToken, tokenHash } from '../../../shared/security/tokens.js';
import { createRealtimeAccessService } from './modules/realtime-access/realtime-access.service.js';
import { realtimeAccessRepository } from './modules/realtime-access/realtime-access.repository.js';
import { createLogService } from './modules/device-logs/logs.service.js';
import { logRepository } from './modules/device-logs/logs.repository.js';
import { createIngestionService } from './modules/ingestion/ingestion.service.js';
import { ingestionRepository, registryEntries } from './modules/ingestion/ingestion.repository.js';
import { outboxRepository } from './modules/outbox/outbox.repository.js';
import { createOutboxJob } from './jobs/outbox.job.js';
import { retainRecords } from './modules/maintenance/retention.repository.js';
import { internalPost } from '../../../shared/http/internal-client.js';
import { logger } from '../../../shared/logging/logger.js';

export function createIngestion(pool: pg.Pool, config: Pick<Config, 'ALLOW_UNVERIFIED_MARKON'>) {
  return createIngestionService({
    inTransaction: (work) => transaction(pool, (c) => work(ingestionRepository(c, randomUUID))),
    registry: (imei) => registryEntries(pool, imei),
    allowUnverified: config.ALLOW_UNVERIFIED_MARKON === 'true',
    now: Date.now,
    newId: randomUUID,
  });
}

export function createBackend(pool: pg.Pool, config: Config) {
  const inTransaction: FleetTransactionRunner = (work) =>
    transaction(pool, (client) =>
      work({
        vehicles: vehicleWriter(client),
        devices: deviceWriter(client),
        assignments: assignmentRepository(client),
        audit: auditRepository(client, randomUUID),
      }),
    );
  const sessions = authRepository(pool);
  const outbox = outboxRepository(pool);
  const services: BackendServices = {
    auth: createAuthService({
      repository: sessions,
      verifyPassword,
      newToken: randomToken,
      tokenHash,
      sessionHours: config.SESSION_HOURS,
    }),
    vehicles: createVehicleService({ read: vehicleReader(pool), inTransaction, newId: randomUUID }),
    devices: createDeviceService({ read: deviceReader(pool), inTransaction }),
    assignments: createAssignmentService({ inTransaction, newId: randomUUID, now: Date.now }),
    logs: createLogService(logRepository(pool), Date.now),
    ingestion: createIngestion(pool, config),
    realtimeAccess: createRealtimeAccessService({
      repository: realtimeAccessRepository(pool),
      sessions,
      newToken: randomToken,
      tokenHash,
    }),
    health: () => checkDatabase(pool),
  };
  const accepted = z.object({ accepted: z.literal(true) });

  return {
    ...services,
    jobs: {
      dispatch: createOutboxJob({
        store: {
          ...outbox,
          claim: () => transaction(pool, (client) => outboxRepository(client).claim()),
        },
        send: async (event) =>
          accepted.parse(
            await internalPost(
              `${config.REALTIME_URL}/internal/v1/events`,
              config.REALTIME_SECRET,
              event,
            ),
          ),
        warn: (err, outboxId) => logger.warn({ err, outboxId }, 'Realtime delivery retry'),
      }),
      retain: () => transaction(pool, retainRecords),
      error: (err: unknown) => logger.error({ err }, 'Background job failed'),
    },
  };
}
