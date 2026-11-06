import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import {
  vehicleInput,
  vehiclePatch,
  profiles,
  registrationKey,
} from '../../../../packages/contracts/src/index.js';
import { transaction } from '../db/index.js';
import { HttpError } from '../http.js';
import { editor, admin } from './auth.js';
const id = z.string().uuid();
async function audit(
  c: pg.PoolClient,
  org: string,
  actor: string,
  action: string,
  target: string,
  changes: unknown,
) {
  await c.query(
    'INSERT INTO audit_logs(id,organization_id,actor_id,action,target_id,changes) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(), org, actor, action, target, JSON.stringify(changes)],
  );
}
export function vehicleRoutes(pool: pg.Pool) {
  const r = Router();
  r.get('/profiles', (_req, res) => {
    res.json({ items: profiles });
  });
  r.get('/vehicles', async (req, res) => {
    const query = z
      .object({
        q: z.string().max(100).default(''),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .parse(req.query);
    const { rows } = await pool.query(
      `SELECT v.*,d.id AS device_id,d.imei,d.model,d.firmware,d.profile_id,d.manufacturer,d.enabled AS device_enabled,d.expected_interval,d.last_received_at,CASE WHEN d.last_received_at>now()-GREATEST(3*d.expected_interval,120)*interval '1 second' THEN 'online' ELSE 'offline' END AS activity FROM vehicles v LEFT JOIN vehicle_device_assignments a ON a.vehicle_id=v.id AND a.valid_to IS NULL LEFT JOIN devices d ON d.id=a.device_id WHERE v.organization_id=$1 AND (v.name ILIKE $2 OR v.registration_number ILIKE $2 OR d.imei ILIKE $2) ORDER BY v.created_at DESC,v.id LIMIT 51 OFFSET $3`,
      [res.locals.user.organization_id, `%${query.q}%`, query.offset],
    );
    res.json({ items: rows.slice(0, 50), nextOffset: rows.length > 50 ? query.offset + 50 : null });
  });
  r.post('/vehicles', editor, async (req, res) => {
    const data = vehicleInput.parse(req.body);
    const profile = profiles.find((p) => p.id === data.profileId)!;
    const user = res.locals.user;
    const result = await transaction(pool, async (c) => {
      const vehicleId = randomUUID(),
        deviceId = randomUUID();
      await c.query(
        'INSERT INTO vehicles(id,organization_id,name,registration_number,registration_key,vehicle_type,notes,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          vehicleId,
          user.organization_id,
          data.name,
          data.registrationNumber,
          registrationKey(data.registrationNumber),
          data.vehicleType,
          data.notes,
          data.enabled,
        ],
      );
      await c.query(
        'INSERT INTO devices(id,organization_id,imei,manufacturer,model,firmware,protocol,profile_id,expected_interval,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          deviceId,
          user.organization_id,
          data.imei,
          profile.manufacturer,
          data.model,
          data.firmware,
          profile.protocol,
          profile.id,
          data.expectedInterval,
          data.enabled,
        ],
      );
      await c.query(
        'INSERT INTO vehicle_device_assignments(id,organization_id,device_id,vehicle_id,valid_from) VALUES($1,$2,$3,$4,now())',
        [randomUUID(), user.organization_id, deviceId, vehicleId],
      );
      await audit(c, user.organization_id, user.id, 'vehicle.created', vehicleId, {
        deviceId,
        profileId: profile.id,
      });
      return { vehicleId, deviceId };
    });
    res.status(201).json(result);
  });
  r.patch('/vehicles/:id', editor, async (req, res) => {
    const vehicleId = id.parse(req.params.id),
      data = vehiclePatch.parse(req.body),
      user = res.locals.user;
    await transaction(pool, async (c) => {
      const { rows } = await c.query(
        'SELECT id FROM vehicles WHERE id=$1 AND organization_id=$2 FOR UPDATE',
        [vehicleId, user.organization_id],
      );
      if (!rows.length) throw new HttpError(404, 'Vehicle not found');
      await c.query(
        `UPDATE vehicles SET name=COALESCE($3,name),registration_number=COALESCE($4,registration_number),registration_key=COALESCE($5,registration_key),vehicle_type=COALESCE($6,vehicle_type),notes=COALESCE($7,notes),enabled=COALESCE($8,enabled),updated_at=now() WHERE id=$1 AND organization_id=$2`,
        [
          vehicleId,
          user.organization_id,
          data.name,
          data.registrationNumber,
          data.registrationNumber ? registrationKey(data.registrationNumber) : null,
          data.vehicleType,
          data.notes,
          data.enabled,
        ],
      );
      await audit(c, user.organization_id, user.id, 'vehicle.updated', vehicleId, data);
    });
    res.json({ ok: true });
  });
  r.patch('/devices/:id', admin, async (req, res) => {
    const deviceId = id.parse(req.params.id),
      data = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    await transaction(pool, async (c) => {
      const result = await c.query(
        'UPDATE devices SET enabled=$3 WHERE id=$1 AND organization_id=$2',
        [deviceId, res.locals.user.organization_id, data.enabled],
      );
      if (!result.rowCount) throw new HttpError(404, 'Device not found');
      await audit(
        c,
        res.locals.user.organization_id,
        res.locals.user.id,
        'device.updated',
        deviceId,
        data,
      );
    });
    res.json({ ok: true });
  });
  r.get('/devices', async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT d.id,d.imei,d.model,d.enabled,NOT EXISTS(SELECT 1 FROM vehicle_device_assignments a WHERE a.device_id=d.id AND a.valid_to IS NULL) AS unassigned FROM devices d WHERE d.organization_id=$1 ORDER BY d.imei LIMIT 1000`,
      [res.locals.user.organization_id],
    );
    res.json({ items: rows });
  });
  r.post('/vehicles/:id/device-assignment', admin, async (req, res) => {
    const vehicleId = id.parse(req.params.id),
      data = z
        .object({
          deviceId: id.optional(),
          device: vehicleInput
            .pick({
              imei: true,
              profileId: true,
              model: true,
              firmware: true,
              expectedInterval: true,
            })
            .optional(),
          effectiveAt: z.string().datetime(),
        })
        .strict()
        .refine(
          (v) => Boolean(v.deviceId) !== Boolean(v.device),
          'Choose an existing or a new tracker',
        )
        .parse(req.body),
      org = res.locals.user.organization_id;
    if (Math.abs(Date.now() - Date.parse(data.effectiveAt)) > 60000)
      throw new HttpError(422, 'Assignments must take effect now (within one minute)');
    await transaction(pool, async (c) => {
      // A single transaction lock serializes rare assignment edits and avoids lock-order cycles.
      await c.query("SELECT pg_advisory_xact_lock(hashtext('fleet-assignments'))");
      const vehicle = await c.query(
        'SELECT id FROM vehicles WHERE id=$1 AND organization_id=$2 FOR UPDATE',
        [vehicleId, org],
      );
      let deviceId = data.deviceId;
      if (data.device) {
        const input = data.device,
          profile = profiles.find((p) => p.id === input.profileId)!;
        deviceId = randomUUID();
        await c.query(
          'INSERT INTO devices(id,organization_id,imei,manufacturer,model,firmware,protocol,profile_id,expected_interval) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            deviceId,
            org,
            input.imei,
            profile.manufacturer,
            input.model,
            input.firmware,
            profile.protocol,
            profile.id,
            input.expectedInterval,
          ],
        );
      }
      const device = await c.query(
        'SELECT id FROM devices WHERE id=$1 AND organization_id=$2 AND enabled FOR UPDATE',
        [deviceId, org],
      );
      if (!vehicle.rowCount || !device.rowCount)
        throw new HttpError(404, 'Vehicle or device not found');
      const assigned = await c.query(
        'SELECT vehicle_id FROM vehicle_device_assignments WHERE device_id=$1 AND valid_to IS NULL',
        [deviceId],
      );
      if (assigned.rowCount) throw new HttpError(409, 'Device already assigned; detach it first');
      await c.query(
        'UPDATE vehicle_device_assignments SET valid_to=$2 WHERE vehicle_id=$1 AND valid_to IS NULL',
        [vehicleId, data.effectiveAt],
      );
      await c.query(
        'INSERT INTO vehicle_device_assignments(id,organization_id,device_id,vehicle_id,valid_from) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), org, deviceId, vehicleId, data.effectiveAt],
      );
      await c.query('DELETE FROM vehicle_latest_state WHERE vehicle_id=$1 AND organization_id=$2', [
        vehicleId,
        org,
      ]);
      await audit(c, org, res.locals.user.id, 'device.assigned', vehicleId, data);
    });
    res.json({ ok: true });
  });
  return r;
}
