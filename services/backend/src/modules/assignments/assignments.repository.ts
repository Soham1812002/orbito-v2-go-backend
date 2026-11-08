import type { SqlExecutor } from '../../database/executor.js';
import type { FleetTransaction } from '../fleet/fleet.ports.js';

export function assignmentRepository(db: SqlExecutor): FleetTransaction['assignments'] {
  return {
    async lock() {
      await db.query(`
      SELECT
        pg_advisory_xact_lock(hashtext ('fleet-assignments'))
    `);
    },
    async create(id, org, device, vehicle, effectiveAt) {
      if (effectiveAt) {
        await db.query(
          `
      INSERT INTO
        vehicle_device_assignments (
          id,
          organization_id,
          device_id,
          vehicle_id,
          valid_from
        )
      VALUES
        ($1, $2, $3, $4, $5)
    `,
          [id, org, device, vehicle, effectiveAt],
        );
      } else {
        await db.query(
          `
      INSERT INTO
        vehicle_device_assignments (
          id,
          organization_id,
          device_id,
          vehicle_id,
          valid_from
        )
      VALUES
        ($1, $2, $3, $4, now())
    `,
          [id, org, device, vehicle],
        );
      }
    },
    async isAssigned(device) {
      return (
        (
          await db.query(
            `
      SELECT
        vehicle_id
      FROM
        vehicle_device_assignments
      WHERE
        device_id = $1
        AND valid_to IS NULL
    `,
            [device],
          )
        ).rows.length > 0
      );
    },
    async close(vehicle, effectiveAt) {
      await db.query(
        `
      UPDATE vehicle_device_assignments
      SET
        valid_to = $2
      WHERE
        vehicle_id = $1
        AND valid_to IS NULL
    `,
        [vehicle, effectiveAt],
      );
    },
    async resetState(org, vehicle) {
      await db.query(
        `
      DELETE FROM vehicle_latest_state
      WHERE
        vehicle_id = $1
        AND organization_id = $2
    `,
        [vehicle, org],
      );
    },
  };
}
