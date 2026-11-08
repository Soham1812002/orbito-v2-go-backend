import type { DeviceLog } from '../../../../../shared/contracts/console.js';
import { element } from '../shared/dom.js';
import { utc } from '../shared/time.js';

function summary(log: DeviceLog) {
  const p = log.location;
  const s = log.status ?? {};
  const parts = [];

  if (p) {
    parts.push(`${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}`);
    if (p.speedKph != null) {
      parts.push(`${p.speedKph} km/h`);
    }
  }

  if (s.ignition != null) {
    parts.push(`Ignition ${s.ignition ? 'ON' : 'OFF'}`);
  }

  if (s.batteryLevel != null) {
    parts.push(`Battery level ${s.batteryLevel}/6`);
  }

  if (s.batteryPercent != null) {
    parts.push(`Battery ${s.batteryPercent}%`);
  }

  if (s.gsmLevel != null) {
    parts.push(`GSM level ${s.gsmLevel}`);
  }

  return parts.join(' · ') || 'No location or status fields provided';
}

export function renderLogs(
  table: HTMLTableSectionElement,
  items: DeviceLog[],
  onDetail: (id: string) => Promise<void>,
) {
  table.replaceChildren();
  for (const log of items) {
    const row = element('tr');
    let cell = element('td');

    cell.append(element('strong', utc(log.received_at)), element('small', utc(log.device_time)));
    row.append(cell);
    cell = element('td');
    cell.append(
      element('strong', log.vehicle_name || 'Unassigned at event time'),
      element('small', `${log.registration_number || ''} ${log.imei}`),
    );
    row.append(cell);
    cell = element('td');
    cell.append(
      element('strong', `${log.packet_type} · ${log.event_type}`),
      element('small', `${log.protocol}${log.historical ? ' · Historical' : ''}`),
    );
    row.append(cell, element('td', summary(log)));
    cell = element('td');
    cell.append(element('span', log.decode_status, 'badge'));
    cell.append(element('small', `Checksum: ${log.checksum_status}`));
    if (log.checksum_status === 'UNVERIFIED') {
      cell.firstElementChild?.classList.add('warn');
    }

    row.append(cell);
    cell = element('td');
    const btn = element('button', 'Details', 'secondary');

    btn.addEventListener('click', () => void onDetail(log.id));
    cell.append(btn);
    row.append(cell);
    table.append(row);
  }

  if (!items.length) {
    const row = element('tr');
    const cell = element('td', 'No device messages match these filters.');

    cell.colSpan = 6;
    row.append(cell);
    table.append(row);
  }
}
