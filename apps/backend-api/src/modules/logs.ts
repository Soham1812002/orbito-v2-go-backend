import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { logQuery } from '../../../../packages/contracts/src/index.js';
import { HttpError } from '../http.js';
export function logRoutes(pool: pg.Pool) {
  const r = Router();
  r.get('/device-logs', async (req, res) => {
    const q = logQuery.parse(req.query);
    const to = q.to ?? new Date().toISOString(),
      from = q.from ?? new Date(Date.parse(to) - 86400000).toISOString();
    if (Date.parse(to) - Date.parse(from) > 7 * 86400000 || Date.parse(to) < Date.parse(from))
      throw new HttpError(422, 'Select a range of at most seven days');
    const params: unknown[] = [res.locals.user.organization_id, from, to];
    const conditions = ['l.organization_id=$1', 'l.received_at >= $2', 'l.received_at <= $3'];
    for (const [key, column] of [
      ['deviceId', 'l.device_id'],
      ['protocol', 'l.protocol'],
      ['packetType', 'l.packet_type'],
      ['decodeStatus', 'l.decode_status'],
    ] as const) {
      if (q[key]) {
        params.push(q[key]);
        conditions.push(`${column}=$${params.length}`);
      }
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      conditions.push(
        `(d.imei ILIKE $${params.length} OR v.name ILIKE $${params.length} OR v.registration_number ILIKE $${params.length})`,
      );
    }
    if (q.cursor) {
      let value: unknown;
      try {
        value = JSON.parse(Buffer.from(q.cursor, 'base64url').toString());
      } catch {
        throw new HttpError(422, 'Invalid cursor');
      }
      const cursor = z.object({ time: z.string().datetime(), id: z.string().uuid() }).parse(value);
      params.push(cursor.time, cursor.id);
      conditions.push(
        `(l.received_at,l.id)<($${params.length - 1}::timestamptz,$${params.length}::uuid)`,
      );
    }
    params.push(q.limit + 1);
    const { rows } = await pool.query(
      `SELECT l.id,l.device_id,l.vehicle_id,l.received_at,l.device_time,l.protocol,l.packet_type,l.event_type,l.decode_status,l.checksum_status,l.historical,l.normalized_data->'location' AS location,l.normalized_data->'status' AS status,d.imei,v.name AS vehicle_name,v.registration_number FROM device_logs l JOIN devices d ON d.id=l.device_id LEFT JOIN vehicles v ON v.id=l.vehicle_id WHERE ${conditions.join(' AND ')} ORDER BY l.received_at DESC,l.id DESC LIMIT $${params.length}`,
      params,
    );
    const items = rows.slice(0, q.limit),
      last = items.at(-1);
    res.json({
      items,
      nextCursor:
        rows.length > q.limit && last
          ? Buffer.from(
              JSON.stringify({ time: last.received_at.toISOString(), id: last.id }),
            ).toString('base64url')
          : null,
      from,
      to,
    });
  });
  r.get('/device-logs/:id', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { rows } = await pool.query(
      'SELECT * FROM device_logs WHERE id=$1 AND organization_id=$2',
      [id, res.locals.user.organization_id],
    );
    if (!rows[0]) throw new HttpError(404, 'Log not found');
    const record = rows[0];
    if (res.locals.user.role !== 'admin') delete record.raw_data;
    res.json(record);
  });
  return r;
}
