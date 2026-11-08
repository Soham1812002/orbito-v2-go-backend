import type { Actor } from '../../application/actor.js';
import { requireAdmin } from '../../application/actor.js';
import { ApplicationError } from '../../../../../shared/errors/application-error.js';
import type { DeviceReader, FleetTransactionRunner } from '../fleet/fleet.ports.js';

export function createDeviceService(deps: {
  read: DeviceReader;
  inTransaction: FleetTransactionRunner;
}) {
  return {
    list(actor: Actor) {
      return deps.read.list(actor.organization_id);
    },
    async setEnabled(actor: Actor, id: string, enabled: boolean) {
      requireAdmin(actor);
      await deps.inTransaction(async (tx) => {
        if (!(await tx.devices.setEnabled(actor.organization_id, id, enabled))) {
          throw new ApplicationError('not_found', 'Device not found');
        }

        await tx.audit.record(actor.organization_id, actor.id, 'device.updated', id, { enabled });
      });
    },
  };
}

export type DeviceService = ReturnType<typeof createDeviceService>;
