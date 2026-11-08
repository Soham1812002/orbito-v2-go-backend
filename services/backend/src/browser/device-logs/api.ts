import type { DeviceLog } from '../../../../../shared/contracts/console.js';
import { api } from '../shared/http.js';
import { object, text, nullableText, number, boolean, list } from '../shared/decode.js';

function log(value: unknown): DeviceLog {
  const row = object(value);
  const status = row.status == null ? {} : object(row.status);
  const location = row.location == null ? null : object(row.location);
  const optionalNumber = (value: unknown) => (value == null ? null : number(value));

  return {
    id: text(row.id),
    received_at: text(row.received_at),
    device_time: nullableText(row.device_time),
    vehicle_name: nullableText(row.vehicle_name),
    registration_number: nullableText(row.registration_number),
    imei: text(row.imei),
    packet_type: text(row.packet_type),
    event_type: text(row.event_type),
    protocol: text(row.protocol),
    historical: boolean(row.historical),
    decode_status: text(row.decode_status),
    checksum_status: text(row.checksum_status),
    location: location
      ? {
          latitude: number(location.latitude),
          longitude: number(location.longitude),
          speedKph: optionalNumber(location.speedKph),
        }
      : null,
    status: {
      ignition: status.ignition == null ? null : boolean(status.ignition),
      batteryLevel: optionalNumber(status.batteryLevel),
      batteryPercent: optionalNumber(status.batteryPercent),
      gsmLevel: optionalNumber(status.gsmLevel),
    },
  };
}

export async function loadLogs(query: URLSearchParams) {
  const data = object(await api(`/api/v1/device-logs?${query}`));

  return { items: list(data.items, log), nextCursor: nullableText(data.nextCursor) };
}

export const loadDetail = (id: string) => api(`/api/v1/device-logs/${id}`);

export async function requestTicket() {
  return text(object(await api('/api/v1/realtime-ticket', { method: 'POST', body: '{}' })).ticket);
}
