import type { SqlExecutor } from '../../database/executor.js';

import type { FleetTransaction, VehicleReader, VehicleRow } from '../fleet/fleet.ports.js';

export function vehicleReader(db: SqlExecutor): VehicleReader {
  return {
    async list(org, q, offset) {
      return (
        await db.query<VehicleRow>(
          `
      SELECT
        v.*,
        d.id AS device_id,
        d.imei,
        d.model,
        d.firmware,
        d.profile_id,
        d.manufacturer,
        d.enabled AS device_enabled,
        d.expected_interval,
        d.last_received_at,
        CASE
          WHEN d.last_received_at > now() - GREATEST(3 * d.expected_interval, 120) * interval '1 second' THEN 'online'
          ELSE 'offline'
        END AS activity
      FROM
        vehicles v
        LEFT JOIN vehicle_device_assignments a ON a.vehicle_id = v.id
        AND a.valid_to IS NULL
        LEFT JOIN devices d ON d.id = a.device_id
      WHERE
        v.organization_id = $1
        AND (
          v.name ILIKE $2
          OR v.registration_number ILIKE $2
          OR d.imei ILIKE $2
        )
      ORDER BY
        v.created_at DESC,
        v.id
      LIMIT
        51
      OFFSET
        $3
    `,
          [org, `%${q}%`, offset],
        )
      ).rows;
    },
  };
}

export function vehicleWriter(db: SqlExecutor): FleetTransaction['vehicles'] {
  return {
    async create(id, org, data) {
      await db.query(
        `
      INSERT INTO
        vehicles (
          id,
          organization_id,
          name,
          registration_number,
          registration_key,
          vehicle_type,
          notes,
          enabled
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
        [
          id,
          org,
          data.name,
          data.registrationNumber,
          data.registrationKey,
          data.vehicleType,
          data.notes,
          data.enabled,
        ],
      );
    },
    async exists(org, id) {
      return (
        (
          await db.query(
            `
      SELECT
        id
      FROM
        vehicles
      WHERE
        id = $1
        AND organization_id = $2
      FOR UPDATE
    `,
            [id, org],
          )
        ).rows.length > 0
      );
    },
    async update(org, id, data) {
      await db.query(
        `
      UPDATE vehicles
      SET
        name = COALESCE($3, name),
        registration_number = COALESCE($4, registration_number),
        registration_key = COALESCE($5, registration_key),
        vehicle_type = COALESCE($6, vehicle_type),
        notes = COALESCE($7, notes),
        enabled = COALESCE($8, enabled),
        updated_at = now()
      WHERE
        id = $1
        AND organization_id = $2
    `,
        [
          id,
          org,
          data.name,
          data.registrationNumber,
          data.registrationKey ?? null,
          data.vehicleType,
          data.notes,
          data.enabled,
        ],
      );
    },
  };
}
