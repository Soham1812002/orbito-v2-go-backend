import type { SqlExecutor } from '../../database/executor.js';
import type { LogReader, LogRow, LogDetail } from './logs.ports.js';

export function logRepository(db: SqlExecutor): LogReader {
  return {
    async list(org, q, from, to, cursor) {
      const params: unknown[] = [org, from, to];
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

      if (cursor) {
        params.push(cursor.time, cursor.id);
        conditions.push(
          `(l.received_at,l.id)<($${params.length - 1}::timestamptz,$${params.length}::uuid)`,
        );
      }

      params.push(q.limit + 1);
      const { rows } = await db.query<LogRow>(
        `
          SELECT
            l.id, l.device_id, l.vehicle_id, l.received_at, l.device_time,
            to_char(l.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_at_exact,
            l.protocol, l.packet_type, l.event_type, l.decode_status,
            l.checksum_status, l.historical,
            l.normalized_data->'location' AS location,
            l.normalized_data->'status' AS status,
            jsonb_build_object(
              'trackingEnabled', l.normalized_data #> '{protocolData,trackingEnabled}',
              'charging', l.normalized_data #> '{protocolData,charging}',
              'defenseActivated', l.normalized_data #> '{protocolData,defenseActivated}',
              'oilElectricityCutOff', l.normalized_data #> '{protocolData,oilElectricityCutOff}',
              'mileageRaw', l.normalized_data #> '{protocolData,mileageRaw}'
            ) AS protocol_data,
            d.imei, v.name AS vehicle_name, v.registration_number
          FROM device_logs l
          JOIN devices d ON d.id = l.device_id
          LEFT JOIN vehicles v ON v.id = l.vehicle_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY l.received_at DESC, l.id DESC
          LIMIT $${params.length}
        `,
        params,
      );

      return rows;
    },
    async detail(org, id) {
      return (
        await db.query<LogDetail>(
          `
      SELECT
        *
      FROM
        device_logs
      WHERE
        id = $1
        AND organization_id = $2
    `,
          [id, org],
        )
      ).rows[0];
    },
  };
}
