import type { Vehicle, Profile } from '../../../../../shared/contracts/console.js';
import { query, element } from '../shared/dom.js';
import { message, errorText } from '../shared/messages.js';
import { loadDevices } from '../shared/catalog.js';
import { saveVehicle, replaceTracker } from './api.js';

export function initializeForms(profiles: Profile[], onSaved: () => Promise<void>) {
  const dialog = query<HTMLDialogElement>('#vehicle-dialog');
  const form = query<HTMLFormElement>('#vehicle-form');
  let editing: string | null = null;

  function openForm(v: Vehicle | null = null) {
    editing = v?.id ?? null;
    form.reset();
    query('#form-error').textContent = '';
    query('#form-title').textContent = editing ? 'Edit vehicle' : 'Add vehicle';
    for (const node of form.querySelectorAll<HTMLElement>('.device-field')) {
      node.hidden = !!editing;
      for (const input of node.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        'input,select',
      )) {
        input.disabled = !!editing;
      }
    }

    if (v) {
      for (const [name, value] of Object.entries({
        name: v.name,
        registrationNumber: v.registration_number,
        vehicleType: v.vehicle_type,
        notes: v.notes,
      })) {
        query<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
          `[name="${name}"]`,
          form,
        ).value = value;
      }

      query<HTMLInputElement>('[name="enabled"]', form).checked = v.enabled;
    }

    profileNote();
    dialog.showModal();
  }

  function profileNote() {
    const profile = profiles.find(
      (p) => p.id === query<HTMLSelectElement>('[name="profileId"]', form).value,
    );

    query('#profile-note').textContent = editing
      ? 'IMEI changes require an explicit tracker replacement.'
      : profile
        ? `Device TCP port: ${profile.port}. ${profile.diagnostic ? 'Markon checksum is unverified. Gateway admission is disabled unless explicitly enabled by the operator.' : 'Documented parser profile; validate actual model and firmware on hardware before production.'}`
        : '';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const save = query<HTMLButtonElement>('#save-vehicle');

    save.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(form));
      const body = editing
        ? {
            name: values.name,
            registrationNumber: values.registrationNumber,
            vehicleType: values.vehicleType,
            notes: values.notes,
            enabled: query<HTMLInputElement>('[name="enabled"]', form).checked,
          }
        : {
            ...values,
            expectedInterval: Number(values.expectedInterval),
            enabled: query<HTMLInputElement>('[name="enabled"]', form).checked,
          };

      await saveVehicle(editing, body);
      dialog.close();
      message(
        'Vehicle saved. Configure the tracker separately with the server address and profile port.',
      );
      await onSaved();
    } catch (e) {
      query('#form-error').textContent = errorText(e);
    } finally {
      save.disabled = false;
    }
  });
  document.querySelector('#add-vehicle')?.addEventListener('click', () => openForm());
  query('#close-dialog').addEventListener('click', () => dialog.close());
  query('#profile').addEventListener('change', profileNote);

  let assignmentVehicle: string | null = null;

  async function openAssignment(vehicleId: string) {
    assignmentVehicle = vehicleId;
    const items = await loadDevices();
    const select = query<HTMLSelectElement>('#replacement-device');

    select.replaceChildren(element('option', 'Register a new tracker below'));
    select.options[0]!.value = '';
    for (const device of items) {
      if (device.enabled && device.unassigned) {
        const option = element('option', `${device.imei} — ${device.model}`);

        option.value = device.id;
        select.append(option);
      }
    }

    query('#assignment-error').textContent = '';
    query<HTMLDialogElement>('#assignment-dialog').showModal();
  }

  query('#close-assignment').addEventListener('click', () =>
    query<HTMLDialogElement>('#assignment-dialog').close(),
  );
  query('#assignment-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await replaceTracker(assignmentVehicle!, {
        ...(query<HTMLSelectElement>('#replacement-device').value
          ? { deviceId: query<HTMLSelectElement>('#replacement-device').value }
          : {
              device: {
                imei: query<HTMLInputElement>('#replacement-imei').value,
                model: query<HTMLInputElement>('#replacement-model').value,
                profileId: query<HTMLSelectElement>('#replacement-profile').value,
                firmware: query<HTMLInputElement>('#replacement-firmware').value,
                expectedInterval: 60,
              },
            }),
        effectiveAt: new Date().toISOString(),
      });
      query<HTMLDialogElement>('#assignment-dialog').close();
      await onSaved();
    } catch (e) {
      query('#assignment-error').textContent = errorText(e);
    }
  });

  for (const profile of profiles) {
    const option = element(
      'option',
      `${profile.manufacturer} — ${profile.model}${profile.diagnostic ? ' (diagnostic)' : ''}`,
    );

    option.value = profile.id;
    query('#profile').append(option);
    query('#replacement-profile').append(option.cloneNode(true));
  }

  return { edit: openForm, replace: openAssignment };
}
