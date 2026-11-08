import { prepareDevice } from '../devices/device-registration.js';
import { registrationKey } from '../../../../../shared/contracts/fleet.js';
import type { Actor } from '../../application/actor.js';
import { requireEditor } from '../../application/actor.js';
import { ApplicationError } from '../../../../../shared/errors/application-error.js';
import type { VehicleInput, VehiclePatch } from '../../../../../shared/contracts/fleet.js';
import type { FleetTransactionRunner, VehicleReader } from '../fleet/fleet.ports.js';

export function createVehicleService(deps: {
  read: VehicleReader;
  inTransaction: FleetTransactionRunner;
  newId: () => string;
}) {
  return {
    async list(actor: Actor, q: string, offset: number) {
      const rows = await deps.read.list(actor.organization_id, q, offset);

      return {
        items: rows.slice(0, 50).map((row) => ({
          ...row,
          last_received_at: row.last_received_at?.toISOString() ?? null,
        })),
        nextOffset: rows.length > 50 ? offset + 50 : null,
      };
    },
    async register(actor: Actor, data: VehicleInput) {
      requireEditor(actor);

      return deps.inTransaction(async (tx) => {
        const vehicleId = deps.newId();
        const deviceId = deps.newId();

        await tx.vehicles.create(vehicleId, actor.organization_id, {
          ...data,
          registrationKey: registrationKey(data.registrationNumber),
        });
        await tx.devices.create(deviceId, actor.organization_id, prepareDevice(data));
        await tx.assignments.create(deps.newId(), actor.organization_id, deviceId, vehicleId);
        await tx.audit.record(actor.organization_id, actor.id, 'vehicle.created', vehicleId, {
          deviceId,
          profileId: data.profileId,
        });

        return { vehicleId, deviceId };
      });
    },
    async update(actor: Actor, id: string, data: VehiclePatch) {
      requireEditor(actor);
      await deps.inTransaction(async (tx) => {
        if (!(await tx.vehicles.exists(actor.organization_id, id))) {
          throw new ApplicationError('not_found', 'Vehicle not found');
        }

        await tx.vehicles.update(actor.organization_id, id, {
          ...data,
          ...(data.registrationNumber
            ? { registrationKey: registrationKey(data.registrationNumber) }
            : {}),
        });
        await tx.audit.record(actor.organization_id, actor.id, 'vehicle.updated', id, data);
      });
    },
  };
}

export type VehicleService = ReturnType<typeof createVehicleService>;
