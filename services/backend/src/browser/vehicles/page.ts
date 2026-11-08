import { query } from '../shared/dom.js';
import { role } from '../shared/session.js';
import { loadProfiles } from '../shared/catalog.js';
import { listVehicles, setDeviceEnabled } from './api.js';
import { renderVehicles } from './table.js';
import { initializeForms } from './forms.js';

export async function startVehiclePage() {
  const table = query<HTMLTableSectionElement>('#vehicles');
  let offset = 0;
  let nextOffset: number | null = null;
  const profiles = await loadProfiles();
  const forms = initializeForms(profiles, async () => {
    offset = 0;
    await load();
  });

  async function load() {
    const data = await listVehicles(offset, query<HTMLInputElement>('#search').value);

    nextOffset = data.nextOffset;
    renderVehicles(table, data.items, role, {
      ...forms,
      setEnabled: async (vehicle) => {
        await setDeviceEnabled(vehicle.device_id!, !vehicle.device_enabled);
        await load();
      },
    });
    query('#vehicle-count').textContent = `${data.items.length} vehicles on this page`;
    query('#more-vehicles').hidden = nextOffset === null;
    query('#first-vehicles').hidden = offset === 0;
  }

  query('#search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    offset = 0;
    void load().catch(report);
  });
  query('#more-vehicles').addEventListener('click', () => {
    offset = nextOffset ?? 0;
    void load().catch(report);
  });
  query('#first-vehicles').addEventListener('click', () => {
    offset = 0;
    void load().catch(report);
  });
  await load();
}

import { message, errorText } from '../shared/messages.js';

function report(error: unknown) {
  message(errorText(error));
}
