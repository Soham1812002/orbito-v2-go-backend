import type { SqlExecutor } from '../../database/executor.js';

import type { Device } from '../../../../../shared/contracts/console.js';
import type { DeviceReader, FleetTransaction } from '../fleet/fleet.ports.js';

export function deviceReader(db: SqlExecutor): DeviceReader {
  return {
    async list(org) {
      return (
        await db.query<Device>(
          `
      SELECT
        d.id,
        d.imei,
        d.model,
        d.enabled,
        NOT EXISTS (
          SELECT
            1
          FROM
            vehicle_device_assignments a
          WHERE
            a.device_id = d.id
            AND a.valid_to IS NULL
        ) AS unassigned
      FROM
        devices d
      WHERE
        d.organization_id = $1
      ORDER BY
        d.imei
      LIMIT
        1000
    `,
          [org],
        )
      ).rows;
    },
  };
}

export function deviceWriter(db: SqlExecutor): FleetTransaction['devices'] {
  return {
    async create(id, org, data) {
      await db.query(
        `
      INSERT INTO
        devices (
          id,
          organization_id,
          imei,
          manufacturer,
          model,
          firmware,
          protocol,
          profile_id,
          expected_interval,
          enabled
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
        [
          id,
          org,
          data.imei,
          data.manufacturer,
          data.model,
          data.firmware,
          data.protocol,
          data.profileId,
          data.expectedInterval,
          data.enabled ?? true,
        ],
      );
    },
    async setEnabled(org, id, enabled) {
      return (
        (
          await db.query(
            `
      UPDATE devices
      SET
        enabled = $3
      WHERE
        id = $1
        AND organization_id = $2
    `,
            [id, org, enabled],
          )
        ).rowCount !== 0
      );
    },
    async enabledExists(org, id) {
      return (
        (
          await db.query(
            `
      SELECT
        id
      FROM
        devices
      WHERE
        id = $1
        AND organization_id = $2
        AND enabled
      FOR UPDATE
    `,
            [id, org],
          )
        ).rows.length > 0
      );
    },
  };
}
