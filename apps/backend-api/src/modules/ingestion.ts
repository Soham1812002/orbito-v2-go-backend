import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import type pg from 'pg';
import {
  decodedEvent,
  profiles,
  type DecodedEvent,
} from '../../../../packages/contracts/src/index.js';
import type { Config } from '../config.js';
import { transaction } from '../db/index.js';
import { HttpError } from '../http.js';
export function fingerprint(e: DecodedEvent) {
  const stable =
    e.deviceTimestamp && e.source.sequence
      ? `${e.deviceTimestamp}:${e.source.sequence}`
      : `${e.source.sessionId}:${e.eventId}`;
  return createHash('sha256')
    .update(
      `${e.deviceIdentifier}:${e.protocol}:${e.profile}:${e.packetType}:${stable}:${e.source.rawSha256}`,
    )
    .digest('hex');
}
export async function ingest(
  pool: pg.Pool,
  input: unknown,
  config: Pick<Config, 'ALLOW_UNVERIFIED_MARKON'>,
) {
  const e = decodedEvent.parse(input);
  if (
    Date.parse(e.receivedAt) > Date.now() + 300000 ||
    Date.parse(e.receivedAt) < Date.now() - 90 * 86400000
  )
    throw new HttpError(422, 'Receive timestamp outside admission horizon');
  return transaction(pool, async (c) => {
    // Shared with assignment edits: ingestion may proceed concurrently, reassignment waits.
    await c.query("SELECT pg_advisory_xact_lock_shared(hashtext('fleet-assignments'))");
    const { rows } = await c.query('SELECT * FROM devices WHERE imei=$1 AND enabled FOR UPDATE', [
      e.deviceIdentifier,
    ]);
    const d = rows[0];
    if (!d) throw new HttpError(409, 'Device not registered or disabled');
    if (d.profile_id !== e.profile || d.protocol !== e.protocol)
      throw new HttpError(409, 'Device profile mismatch');
    const isDecoded = e.validation.decodeStatus === 'DECODED';
    const unverified = e.validation.checksum === 'UNVERIFIED';
    if (isDecoded && unverified && config.ALLOW_UNVERIFIED_MARKON !== 'true')
      throw new HttpError(422, 'Unverified checksum admission disabled');
    if (isDecoded && e.protocol === 'CONCOX' && e.validation.checksum !== 'VALID')
      throw new HttpError(422, 'Concox requires valid CRC');
    const receipt = await c.query(
      'INSERT INTO ingestion_receipts(event_id,organization_id,device_id,fingerprint,received_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING event_id',
      [e.eventId, d.organization_id, d.id, fingerprint(e), e.receivedAt],
    );
    if (!receipt.rowCount) return { eventId: e.eventId, persisted: true, duplicate: true };
    const trustedTime =
      e.deviceTimestamp && Date.parse(e.deviceTimestamp) <= Date.parse(e.receivedAt) + 300000;
    const observed = e.deviceTimestamp ?? e.receivedAt;
    const assignment = await c.query(
      `SELECT a.vehicle_id FROM vehicle_device_assignments a WHERE a.device_id=$1 AND a.valid_from<=$2 AND (a.valid_to IS NULL OR a.valid_to>$2)`,
      [
        d.id,
        trustedTime
          ? e.deviceTimestamp
          : e.eventType === 'LOGIN' || e.eventType === 'HEARTBEAT'
            ? e.receivedAt
            : null,
      ],
    );
    const vehicleId = assignment.rows[0]?.vehicle_id ?? null;
    const logId = randomUUID();
    const safeEvent = { ...e, source: { ...e.source, raw: undefined } };
    await c.query(
      `INSERT INTO device_logs(id,event_id,organization_id,device_id,vehicle_id,received_at,device_time,protocol,packet_type,event_type,decode_status,checksum_status,normalized_data,raw_data,parser_version,historical) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
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
        '1',
        e.historical,
      ],
    );
    if (isDecoded) {
      await c.query(
        'UPDATE devices SET last_received_at=GREATEST(last_received_at,$2::timestamptz) WHERE id=$1',
        [d.id, e.receivedAt],
      );
      if (trustedTime && e.location)
        await c.query(
          `INSERT INTO gps_points(id,event_id,organization_id,device_id,vehicle_id,device_time,received_at,position,speed_kph,heading_degrees,gps_valid,historical) VALUES($1,$2,$3,$4,$5,$6,$7,ST_SetSRID(ST_MakePoint($8,$9),4326),$10,$11,$12,$13)`,
          [
            randomUUID(),
            e.eventId,
            d.organization_id,
            d.id,
            vehicleId,
            e.deviceTimestamp,
            e.receivedAt,
            e.location.longitude,
            e.location.latitude,
            e.location.speedKph,
            e.location.headingDegrees,
            e.status.gpsValid ?? null,
            e.historical,
          ],
        );
      const currentAssignment = await c.query(
        `SELECT a.vehicle_id FROM vehicle_device_assignments a JOIN vehicles v ON v.id=a.vehicle_id WHERE a.device_id=$1 AND a.valid_to IS NULL AND a.valid_from<=now() AND v.enabled`,
        [d.id],
      );
      const currentVehicleId = currentAssignment.rows[0]?.vehicle_id;
      if (currentVehicleId) {
        await c.query(
          `INSERT INTO vehicle_latest_state(vehicle_id,organization_id,device_id,last_received_at) VALUES($1,$2,$3,$4) ON CONFLICT(vehicle_id) DO UPDATE SET last_received_at=GREATEST(vehicle_latest_state.last_received_at,EXCLUDED.last_received_at),revision=vehicle_latest_state.revision+1`,
          [currentVehicleId, d.organization_id, d.id, e.receivedAt],
        );
        if (
          !e.historical &&
          vehicleId === currentVehicleId &&
          trustedTime &&
          e.location &&
          e.status.gpsValid === true
        )
          await c.query(
            `UPDATE vehicle_latest_state SET position=ST_SetSRID(ST_MakePoint($2,$3),4326),location_time=$4 WHERE vehicle_id=$1 AND (location_time IS NULL OR location_time<$4::timestamptz)`,
            [currentVehicleId, e.location.longitude, e.location.latitude, e.deviceTimestamp],
          );
        if (
          !e.historical &&
          ((trustedTime && vehicleId === currentVehicleId) || e.eventType === 'HEARTBEAT') &&
          e.status.ignition != null
        )
          await c.query(
            'UPDATE vehicle_latest_state SET ignition=$2,ignition_time=$3 WHERE vehicle_id=$1 AND (ignition_time IS NULL OR ignition_time<$3::timestamptz)',
            [currentVehicleId, e.status.ignition, observed],
          );
      }
    }
    await c.query(
      'INSERT INTO realtime_outbox(id,organization_id,device_id,log_id) VALUES($1,$2,$3,$4)',
      [randomUUID(), d.organization_id, d.id, logId],
    );
    return { eventId: e.eventId, persisted: true, duplicate: false };
  });
}
export function gatewayRoutes(pool: pg.Pool, config: Config) {
  const r = Router();
  r.get('/device-registry', async (req, res) => {
    const imei = typeof req.query.imei === 'string' ? req.query.imei : null;
    if (imei && !/^\d{15}$/.test(imei)) throw new HttpError(422, 'Invalid IMEI');
    const { rows } = await pool.query(
      'SELECT imei,profile_id AS profile,enabled FROM devices WHERE ($1::text IS NULL OR imei=$1)',
      [imei],
    );
    res.json({
      items: rows.map((d) => ({
        ...d,
        enabled:
          d.enabled &&
          (!profiles.find((p) => p.id === d.profile)?.diagnostic ||
            config.ALLOW_UNVERIFIED_MARKON === 'true'),
      })),
    });
  });
  r.post('/events', async (req, res) => {
    res.json(await ingest(pool, req.body, config));
  });
  return r;
}
