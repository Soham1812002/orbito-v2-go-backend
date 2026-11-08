import type { Device, Profile } from '../../../../../shared/contracts/console.js';
import { api } from './http.js';
import { object, text, number, boolean, list } from './decode.js';

export async function loadDevices(): Promise<Device[]> {
  return list(object(await api('/api/v1/devices')).items, (item) => {
    const row = object(item);

    return {
      id: text(row.id),
      imei: text(row.imei),
      model: text(row.model),
      enabled: boolean(row.enabled),
      unassigned: boolean(row.unassigned),
    };
  });
}

export async function loadProfiles(): Promise<Profile[]> {
  return list(object(await api('/api/v1/profiles')).items, (item) => {
    const row = object(item);

    return {
      id: text(row.id),
      manufacturer: text(row.manufacturer),
      model: text(row.model),
      port: number(row.port),
      diagnostic: boolean(row.diagnostic),
    };
  });
}
