import type { SqlExecutor } from '../../database/executor.js';
import type { IngestionTransaction, RegisteredDevice, RegistryEntry } from './ingestion.ports.js';
import { outboxWriter } from '../outbox/outbox.repository.js';

export function ingestionRepository(db: SqlExecutor, newId: () => string): IngestionTransaction {
  const outbox = outboxWriter(db, newId);

  return {
    async lockAssignments() {
      await db.query(`
      SELECT
        pg_advisory_xact_lock_shared(hashtext ('fleet-assignments'))
    `);
    },
    async findDevice(imei) {
      return (
        await db.query<RegisteredDevice>(
          `
      SELECT
        *
      FROM
        devices
      WHERE
        imei = $1
        AND enabled
      FOR UPDATE
    `,
          [imei],
        )
      ).rows[0];
    },
    async addReceipt(e, d, fingerprint) {
      return (
        (
          await db.query(
            `
      INSERT INTO
        ingestion_receipts (
          event_id,
          organization_id,
          device_id,
          fingerprint,
          received_at
        )
      VALUES
        ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING
      RETURNING
        event_id
    `,
            [e.eventId, d.organization_id, d.id, fingerprint, e.receivedAt],
          )
        ).rowCount !== 0
      );
    },
    async findAssignment(device, time) {
      return (
        (
          await db.query<{ vehicle_id: string }>(
            `
      SELECT
        a.vehicle_id
      FROM
        vehicle_device_assignments a
      WHERE
        a.device_id = $1
        AND a.valid_from <= $2
        AND (
          a.valid_to IS NULL
          OR a.valid_to > $2
        )
    `,
            [device, time],
          )
        ).rows[0]?.vehicle_id ?? null
      );
    },
    async saveLog(e, d, vehicleId, logId) {
      const safeEvent = { ...e, source: { ...e.source, raw: undefined } };

      await db.query(
        `
      INSERT INTO
        device_logs (
          id,
          event_id,
          organization_id,
          device_id,
          vehicle_id,
          received_at,
          device_time,
          protocol,
          packet_type,
          event_type,
          decode_status,
          checksum_status,
          normalized_data,
          raw_data,
          parser_version,
          historical
        )
      VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15,
          $16
        )
    `,
        [
          logId,
          e.eventId,
          d.organization_id,
          d.id,
          vehicleId,
          e.receivedAt,
          e.deviceTimestamp,
          e.protocol,
          e.packetType,
          e.eventType,
          e.validation.decodeStatus,
          e.validation.checksum,
          JSON.stringify(safeEvent),
          e.source.raw ?? null,
          e.parserVersion,
          e.historical,
        ],
      );
    },
    async updateActivity(device, received) {
      await db.query(
        `
      UPDATE devices
      SET
        last_received_at = GREATEST(last_received_at, $2::timestamptz)
      WHERE
        id = $1
    `,
        [device, received],
      );
    },
    async savePoint(e, d, vehicleId, point) {
      await db.query(
        `
      INSERT INTO
        gps_points (
          id,
          event_id,
          organization_id,
          device_id,
          vehicle_id,
          device_time,
          received_at,
          position,
          speed_kph,
          heading_degrees,
          gps_valid,
          historical
        )
      VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          ST_SetSRID (ST_MakePoint ($8, $9), 4326),
          $10,
          $11,
          $12,
          $13
        )
    `,
        [
          newId(),
          e.eventId,
          d.organization_id,
          d.id,
          vehicleId,
          e.deviceTimestamp,
          e.receivedAt,
          point.longitude,
          point.latitude,
          point.speedKph,
          point.headingDegrees,
          e.status.gpsValid ?? null,
          e.historical,
        ],
      );
    },
    async currentVehicle(device) {
      return (
        await db.query<{ vehicle_id: string }>(
          `
      SELECT
        a.vehicle_id
      FROM
        vehicle_device_assignments a
        JOIN vehicles v ON v.id = a.vehicle_id
      WHERE
        a.device_id = $1
        AND a.valid_to IS NULL
        AND a.valid_from <= now()
        AND v.enabled
    `,
          [device],
        )
      ).rows[0]?.vehicle_id;
    },
    async updateCommunication(currentVehicleId, d, receivedAt) {
      await db.query(
        `
      INSERT INTO
        vehicle_latest_state (
          vehicle_id,
          organization_id,
          device_id,
          last_received_at
        )
      VALUES
        ($1, $2, $3, $4)
      ON CONFLICT (vehicle_id) DO UPDATE
      SET
        last_received_at = GREATEST(
          vehicle_latest_state.last_received_at,
          EXCLUDED.last_received_at
        ),
        revision = vehicle_latest_state.revision + 1
    `,
        [currentVehicleId, d.organization_id, d.id, receivedAt],
      );
    },
    async updatePosition(currentVehicleId, point, time) {
      await db.query(
        `
      UPDATE vehicle_latest_state
      SET
        position = ST_SetSRID (ST_MakePoint ($2, $3), 4326),
        location_time = $4
      WHERE
        vehicle_id = $1
        AND (
          location_time IS NULL
          OR location_time < $4::timestamptz
        )
    `,
        [currentVehicleId, point.longitude, point.latitude, time],
      );
    },
    async updateIgnition(currentVehicleId, ignition, observed) {
      await db.query(
        `
      UPDATE vehicle_latest_state
      SET
        ignition = $2,
        ignition_time = $3
      WHERE
        vehicle_id = $1
        AND (
          ignition_time IS NULL
          OR ignition_time < $3::timestamptz
        )
    `,
        [currentVehicleId, ignition, observed],
      );
    },
    async enqueue(d, logId, event) {
      await outbox.enqueue(d.organization_id, d.id, logId, event);
    },
  };
}

export async function registryEntries(db: SqlExecutor, imei: string | null) {
  return (
    await db.query<RegistryEntry>(
      `
      SELECT
        imei,
        profile_id AS profile,
        enabled
      FROM
        devices
      WHERE
        (
          $1::text IS NULL
          OR imei = $1
        )
    `,
      [imei],
    )
  ).rows;
}
