import type { Vehicle } from '../../../../../shared/contracts/console.js';
import { api } from '../shared/http.js';
import { object, text, boolean, nullableText, number, list } from '../shared/decode.js';

function vehicle(value: unknown): Vehicle {
  const row = object(value);

  return {
    id: text(row.id),
    name: text(row.name),
    registration_number: text(row.registration_number),
    vehicle_type: text(row.vehicle_type),
    notes: text(row.notes),
    enabled: boolean(row.enabled),
    device_id: nullableText(row.device_id),
    device_enabled: row.device_enabled == null ? null : boolean(row.device_enabled),
    model: nullableText(row.model),
    imei: nullableText(row.imei),
    profile_id: nullableText(row.profile_id),
    activity: text(row.activity),
    last_received_at: nullableText(row.last_received_at),
  };
}

export async function listVehicles(offset: number, q: string) {
  const data = object(await api(`/api/v1/vehicles?offset=${offset}&q=${encodeURIComponent(q)}`));

  return {
    items: list(data.items, vehicle),
    nextOffset: data.nextOffset == null ? null : number(data.nextOffset),
  };
}

export const saveVehicle = (id: string | null, body: unknown) =>
  api(id ? `/api/v1/vehicles/${id}` : '/api/v1/vehicles', {
    method: id ? 'PATCH' : 'POST',
    body: JSON.stringify(body),
  });

export const setDeviceEnabled = (id: string, enabled: boolean) =>
  api(`/api/v1/devices/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });

export const replaceTracker = (id: string, body: unknown) =>
  api(`/api/v1/vehicles/${id}/device-assignment`, { method: 'POST', body: JSON.stringify(body) });
