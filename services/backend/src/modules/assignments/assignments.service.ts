import { prepareDevice } from '../devices/device-registration.js';
import type { Actor } from '../../application/actor.js';
import { requireAdmin } from '../../application/actor.js';
import { ApplicationError } from '../../../../../shared/errors/application-error.js';
import type { AssignmentInput } from './assignments.schemas.js';
import type { FleetTransactionRunner } from '../fleet/fleet.ports.js';

export function createAssignmentService(deps: {
  inTransaction: FleetTransactionRunner;
  newId: () => string;
  now: () => number;
}) {
  return {
    async replace(actor: Actor, vehicleId: string, data: AssignmentInput) {
      requireAdmin(actor);
      if (Math.abs(deps.now() - Date.parse(data.effectiveAt)) > 60000) {
        throw new ApplicationError(
          'invalid_input',
          'Assignments must take effect now (within one minute)',
        );
      }

      await deps.inTransaction(async (tx) => {
        await tx.assignments.lock();
        const vehicle = await tx.vehicles.exists(actor.organization_id, vehicleId);
        let deviceId = data.deviceId;

        if (data.device) {
          deviceId = deps.newId();
          await tx.devices.create(deviceId, actor.organization_id, prepareDevice(data.device));
        }

        if (
          !vehicle ||
          !deviceId ||
          !(await tx.devices.enabledExists(actor.organization_id, deviceId))
        ) {
          throw new ApplicationError('not_found', 'Vehicle or device not found');
        }

        if (await tx.assignments.isAssigned(deviceId)) {
          throw new ApplicationError('conflict', 'Device already assigned; detach it first');
        }

        await tx.assignments.close(vehicleId, data.effectiveAt);
        await tx.assignments.create(
          deps.newId(),
          actor.organization_id,
          deviceId,
          vehicleId,
          data.effectiveAt,
        );
        await tx.assignments.resetState(actor.organization_id, vehicleId);
        await tx.audit.record(actor.organization_id, actor.id, 'device.assigned', vehicleId, data);
      });
    },
  };
}

export type AssignmentService = ReturnType<typeof createAssignmentService>;
