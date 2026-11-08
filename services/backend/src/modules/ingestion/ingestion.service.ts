import { decodedEvent } from '../../../../../shared/contracts/events.js';
import { profiles } from '../../../../../shared/contracts/fleet.js';
import { ApplicationError } from '../../../../../shared/errors/application-error.js';
import { fingerprint, assertDeviceAdmission } from './ingestion.policy.js';
import type { IngestionDependencies } from './ingestion.ports.js';

export function createIngestionService(deps: IngestionDependencies) {
  return {
    async ingest(input: unknown) {
      const e = decodedEvent.parse(input);

      if (
        Date.parse(e.receivedAt) > deps.now() + 300000 ||
        Date.parse(e.receivedAt) < deps.now() - 90 * 86400000
      ) {
        throw new ApplicationError('invalid_input', 'Receive timestamp outside admission horizon');
      }

      return deps.inTransaction(async (r) => {
        // Shared with assignment edits: ingestion may proceed concurrently, reassignment waits.
        await r.lockAssignments();
        const d = await r.findDevice(e.deviceIdentifier);

        if (!d) {
          throw new ApplicationError('conflict', 'Device not registered or disabled');
        }

        assertDeviceAdmission(e, d, deps.allowUnverified);
        const isDecoded = e.validation.decodeStatus === 'DECODED';
        const receipt = await r.addReceipt(e, d, fingerprint(e));

        if (!receipt) {
          return { eventId: e.eventId, persisted: true, duplicate: true };
        }

        const trustedTime =
          e.deviceTimestamp && Date.parse(e.deviceTimestamp) <= Date.parse(e.receivedAt) + 300000;
        const observed = e.deviceTimestamp ?? e.receivedAt;
        const vehicleId = await r.findAssignment(
          d.id,
          trustedTime
            ? e.deviceTimestamp
            : e.eventType === 'LOGIN' || e.eventType === 'HEARTBEAT'
              ? e.receivedAt
              : null,
        );
        const logId = deps.newId();

        await r.saveLog(e, d, vehicleId, logId);
        if (isDecoded) {
          await r.updateActivity(d.id, e.receivedAt);
          if (trustedTime && e.location) {
            await r.savePoint(e, d, vehicleId, e.location);
          }

          const currentVehicleId = await r.currentVehicle(d.id);

          if (currentVehicleId) {
            await r.updateCommunication(currentVehicleId, d, e.receivedAt);
            if (
              !e.historical &&
              vehicleId === currentVehicleId &&
              trustedTime &&
              e.location &&
              e.status.gpsValid === true
            ) {
              await r.updatePosition(currentVehicleId, e.location, e.deviceTimestamp);
            }

            if (
              !e.historical &&
              ((trustedTime && vehicleId === currentVehicleId) || e.eventType === 'HEARTBEAT') &&
              e.status.ignition != null
            ) {
              await r.updateIgnition(currentVehicleId, e.status.ignition, observed);
            }
          }
        }

        await r.enqueue(d, logId);

        return { eventId: e.eventId, persisted: true, duplicate: false };
      });
    },
    async registry(imei: string | null) {
      const entries = await deps.registry(imei);

      return {
        items: entries.map((d) => ({
          ...d,
          enabled:
            d.enabled &&
            (!profiles.find((p) => p.id === d.profile)?.diagnostic || deps.allowUnverified),
        })),
      };
    },
  };
}

export type IngestionService = ReturnType<typeof createIngestionService>;
