import { api, message, element, utc } from './common.js';
const form = document.querySelector('#filters'),
  table = document.querySelector('#logs');
let cursor = null,
  nextCursor = null,
  live = true,
  loading = false,
  pending = false,
  requestGeneration = 0,
  socket;
const dateInput = (d) => d.toISOString().slice(0, 16);
form.elements.from.value = dateInput(new Date(Date.now() - 86400000));
form.elements.to.value = dateInput(new Date());
function parameters() {
  const query = new URLSearchParams();
  for (const [key, value] of new FormData(form)) {
    if (!value) continue;
    query.set(key, key === 'from' || key === 'to' ? new Date(`${value}:00Z`).toISOString() : value);
  }
  if (cursor) query.set('cursor', cursor);
  return query;
}
function summary(log) {
  const p = log.location,
    s = log.status ?? {};
  const parts = [];
  if (p) {
    parts.push(`${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}`);
    if (p.speedKph != null) parts.push(`${p.speedKph} km/h`);
  }
  if (s.ignition != null) parts.push(`Ignition ${s.ignition ? 'ON' : 'OFF'}`);
  if (s.batteryLevel != null) parts.push(`Battery level ${s.batteryLevel}/6`);
  if (s.batteryPercent != null) parts.push(`Battery ${s.batteryPercent}%`);
  if (s.gsmLevel != null) parts.push(`GSM level ${s.gsmLevel}`);
  return parts.join(' · ') || 'No location or status fields provided';
}
async function detail(id) {
  try {
    const data = await api(`/api/v1/device-logs/${id}`);
    document.querySelector('#detail-content').textContent = JSON.stringify(data, null, 2);
    document.querySelector('#log-detail').showModal();
  } catch (e) {
    message(e.message);
  }
}
async function load() {
  if (loading) {
    pending = true;
    return;
  }
  loading = true;
  const generation = ++requestGeneration;
  try {
    const data = await api(`/api/v1/device-logs?${parameters()}`);
    if (generation !== requestGeneration) return;
    nextCursor = data.nextCursor;
    table.replaceChildren();
    for (const log of data.items) {
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
      if (log.checksum_status === 'UNVERIFIED') cell.firstChild.classList.add('warn');
      row.append(cell);
      cell = element('td');
      const btn = element('button', 'Details', 'secondary');
      btn.addEventListener('click', () => void detail(log.id));
      cell.append(btn);
      row.append(cell);
      table.append(row);
    }
    if (!data.items.length) {
      const row = element('tr');
      const cell = element('td', 'No device messages match these filters.');
      cell.colSpan = 6;
      row.append(cell);
      table.append(row);
    }
    document.querySelector('#log-count').textContent = `${data.items.length} saved messages`;
    document.querySelector('#older').hidden = !nextCursor;
  } catch (e) {
    message(e.message);
  } finally {
    loading = false;
    if (pending) {
      pending = false;
      void load();
    }
  }
}
function newest() {
  cursor = null;
  form.elements.to.value = dateInput(new Date(Date.now() + 60000));
  void load();
}
form.addEventListener('submit', (e) => {
  e.preventDefault();
  live = false;
  updateLive();
  cursor = null;
  void load();
});
document.querySelector('#older').addEventListener('click', () => {
  live = false;
  cursor = nextCursor;
  updateLive();
  void load();
});
document.querySelector('#newest').addEventListener('click', () => {
  live = true;
  updateLive();
  newest();
});
document.querySelector('#toggle-live').addEventListener('click', () => {
  live = !live;
  updateLive();
  if (live) newest();
});
document
  .querySelector('#close-detail')
  .addEventListener('click', () => document.querySelector('#log-detail').close());
function updateLive() {
  document.querySelector('#toggle-live').textContent = live ? 'Pause live' : 'Resume live';
  document.querySelector('#live-note').textContent = live
    ? 'Live: saved messages refresh automatically.'
    : 'Paused: ingestion continues. Resume to reload newest messages.';
}
let refreshTimer;
function scheduleRefresh() {
  if (!live) return;
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    newest();
  }, 500);
}
async function connect() {
  const { ticket } = await api('/api/v1/realtime-ticket', { method: 'POST', body: '{}' });
  socket = window.io({ autoConnect: false, reconnection: false, auth: { ticket } });
  socket.on('connect', () => {
    document.querySelector('#connection').textContent = 'Live connected';
    if (live) newest();
  });
  socket.on('device:log', scheduleRefresh);
  socket.on('disconnect', () => {
    document.querySelector('#connection').textContent = 'Disconnected · retrying';
    setTimeout(() => void reconnect(), 3000);
  });
  socket.on('connect_error', () => {
    document.querySelector('#connection').textContent = 'Connection unavailable';
    socket.close();
    setTimeout(() => void reconnect(), 5000);
  });
  socket.connect();
}
let reconnecting = false;
async function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  socket?.removeAllListeners();
  socket?.close();
  try {
    await connect();
  } catch (e) {
    message(e.message);
    setTimeout(() => void reconnect(), 5000);
  } finally {
    reconnecting = false;
  }
}
try {
  const { items } = await api('/api/v1/devices');
  for (const d of items) {
    const option = element('option', `${d.imei} — ${d.model}`);
    option.value = d.id;
    document.querySelector('#device-filter').append(option);
  }
  const selected = new URLSearchParams(location.search).get('deviceId');
  if (selected) form.elements.deviceId.value = selected;
  await load();
  await connect();
} catch (e) {
  message(e.message);
}
