import { api, message, element, utc, role } from './common.js';
const table = document.querySelector('#vehicles'),
  dialog = document.querySelector('#vehicle-dialog'),
  form = document.querySelector('#vehicle-form');
let editing = null,
  offset = 0,
  nextOffset = null,
  profiles = [];
function button(text, action) {
  const node = element('button', text, 'secondary');
  node.type = 'button';
  node.addEventListener('click', () => Promise.resolve(action()).catch((e) => message(e.message)));
  return node;
}
async function load() {
  try {
    const data = await api(
      `/api/v1/vehicles?offset=${offset}&q=${encodeURIComponent(document.querySelector('#search').value)}`,
    );
    nextOffset = data.nextOffset;
    table.replaceChildren();
    for (const v of data.items) {
      const row = element('tr');
      let cell = element('td');
      cell.append(element('strong', v.name), element('small', v.registration_number));
      row.append(cell);
      cell = element('td');
      cell.append(
        element('strong', v.model || 'No tracker'),
        element('small', v.imei || 'Not assigned'),
      );
      row.append(cell, element('td', v.profile_id || 'Not assigned'));
      cell = element('td');
      cell.append(
        element(
          'span',
          !v.enabled ? 'Vehicle disabled' : !v.device_enabled ? 'Tracker disabled' : v.activity,
          'badge',
        ),
      );
      row.append(cell, element('td', utc(v.last_received_at)));
      const actions = element('td');
      const wrap = element('div', undefined, 'actions');
      if (v.device_id) {
        const link = element('a', 'View logs');
        link.href = `/device-logs?deviceId=${v.device_id}`;
        wrap.append(link);
      }
      if (role !== 'viewer') wrap.append(button('Edit', () => openForm(v)));
      if (role === 'admin' && v.device_id) {
        wrap.append(
          button(v.device_enabled ? 'Disable tracker' : 'Enable tracker', async () => {
            await api(`/api/v1/devices/${v.device_id}`, {
              method: 'PATCH',
              body: JSON.stringify({ enabled: !v.device_enabled }),
            });
            await load();
          }),
        );
        wrap.append(button('Replace tracker', () => openAssignment(v.id)));
      }
      actions.append(wrap);
      row.append(actions);
      table.append(row);
    }
    if (!data.items.length) {
      const tr = element('tr');
      const td = element('td', 'No vehicles yet. Add a vehicle to begin.');
      td.colSpan = 6;
      tr.append(td);
      table.append(tr);
    }
    document.querySelector('#vehicle-count').textContent =
      `${data.items.length} vehicles on this page`;
    document.querySelector('#more-vehicles').hidden = nextOffset === null;
    document.querySelector('#first-vehicles').hidden = offset === 0;
  } catch (e) {
    message(e.message);
  }
}
function openForm(v = null) {
  editing = v?.id ?? null;
  form.reset();
  document.querySelector('#form-error').textContent = '';
  document.querySelector('#form-title').textContent = editing ? 'Edit vehicle' : 'Add vehicle';
  for (const node of form.querySelectorAll('.device-field')) {
    node.hidden = !!editing;
    for (const input of node.querySelectorAll('input,select')) input.disabled = !!editing;
  }
  if (v) {
    for (const [name, value] of Object.entries({
      name: v.name,
      registrationNumber: v.registration_number,
      vehicleType: v.vehicle_type,
      notes: v.notes,
    }))
      form.elements.namedItem(name).value = value;
    form.elements.enabled.checked = v.enabled;
  }
  profileNote();
  dialog.showModal();
}
function profileNote() {
  const profile = profiles.find((p) => p.id === form.elements.profileId.value);
  document.querySelector('#profile-note').textContent = editing
    ? 'IMEI changes require an explicit tracker replacement.'
    : profile
      ? `Device TCP port: ${profile.port}. ${profile.diagnostic ? 'Markon checksum is unverified. Gateway admission is disabled unless explicitly enabled by the operator.' : 'Documented parser profile; validate actual model and firmware on hardware before production.'}`
      : '';
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const save = document.querySelector('#save-vehicle');
  save.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    const body = editing
      ? {
          name: values.name,
          registrationNumber: values.registrationNumber,
          vehicleType: values.vehicleType,
          notes: values.notes,
          enabled: form.elements.enabled.checked,
        }
      : {
          ...values,
          expectedInterval: Number(values.expectedInterval),
          enabled: form.elements.enabled.checked,
        };
    await api(editing ? `/api/v1/vehicles/${editing}` : '/api/v1/vehicles', {
      method: editing ? 'PATCH' : 'POST',
      body: JSON.stringify(body),
    });
    dialog.close();
    message(
      'Vehicle saved. Configure the tracker separately with the server address and profile port.',
    );
    offset = 0;
    await load();
  } catch (e) {
    document.querySelector('#form-error').textContent = e.message;
  } finally {
    save.disabled = false;
  }
});
document.querySelector('#add-vehicle')?.addEventListener('click', () => openForm());
document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
document.querySelector('#profile').addEventListener('change', profileNote);
document.querySelector('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  offset = 0;
  void load();
});
document.querySelector('#more-vehicles').addEventListener('click', () => {
  offset = nextOffset;
  void load();
});
document.querySelector('#first-vehicles').addEventListener('click', () => {
  offset = 0;
  void load();
});
let assignmentVehicle = null;
async function openAssignment(vehicleId) {
  assignmentVehicle = vehicleId;
  const { items } = await api('/api/v1/devices');
  const select = document.querySelector('#replacement-device');
  select.replaceChildren(element('option', 'Register a new tracker below'));
  select.firstChild.value = '';
  for (const device of items)
    if (device.enabled && device.unassigned) {
      const option = element('option', `${device.imei} — ${device.model}`);
      option.value = device.id;
      select.append(option);
    }
  document.querySelector('#assignment-error').textContent = '';
  document.querySelector('#assignment-dialog').showModal();
}
document
  .querySelector('#close-assignment')
  .addEventListener('click', () => document.querySelector('#assignment-dialog').close());
document.querySelector('#assignment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api(`/api/v1/vehicles/${assignmentVehicle}/device-assignment`, {
      method: 'POST',
      body: JSON.stringify({
        ...(document.querySelector('#replacement-device').value
          ? { deviceId: document.querySelector('#replacement-device').value }
          : {
              device: {
                imei: document.querySelector('#replacement-imei').value,
                model: document.querySelector('#replacement-model').value,
                profileId: document.querySelector('#replacement-profile').value,
                firmware: document.querySelector('#replacement-firmware').value,
                expectedInterval: 60,
              },
            }),
        effectiveAt: new Date().toISOString(),
      }),
    });
    document.querySelector('#assignment-dialog').close();
    await load();
  } catch (e) {
    document.querySelector('#assignment-error').textContent = e.message;
  }
});
try {
  ({ items: profiles } = await api('/api/v1/profiles'));
  for (const profile of profiles) {
    const option = element(
      'option',
      `${profile.manufacturer} — ${profile.model}${profile.diagnostic ? ' (diagnostic)' : ''}`,
    );
    option.value = profile.id;
    document.querySelector('#profile').append(option);
    document.querySelector('#replacement-profile').append(option.cloneNode(true));
  }
  await load();
} catch (e) {
  message(e.message);
}
