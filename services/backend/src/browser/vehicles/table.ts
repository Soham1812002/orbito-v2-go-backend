import type { Vehicle } from '../../../../../shared/contracts/console.js';
import { element } from '../shared/dom.js';
import { utc } from '../shared/time.js';
import { message, errorText } from '../shared/messages.js';

function button(text: string, action: () => void | Promise<void>) {
  const node = element('button', text, 'secondary');

  node.type = 'button';
  node.addEventListener('click', () =>
    Promise.resolve(action()).catch((e) => message(errorText(e))),
  );

  return node;
}

export function renderVehicles(
  table: HTMLTableSectionElement,
  items: Vehicle[],
  role: string | undefined,
  callbacks: {
    edit: (v: Vehicle) => void;
    replace: (id: string) => Promise<void>;
    setEnabled: (v: Vehicle) => Promise<void>;
  },
) {
  table.replaceChildren();
  for (const v of items) {
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

    if (role !== 'viewer') {
      wrap.append(button('Edit', () => callbacks.edit(v)));
    }

    if (role === 'admin' && v.device_id) {
      wrap.append(
        button(v.device_enabled ? 'Disable tracker' : 'Enable tracker', async () => {
          await callbacks.setEnabled(v);
        }),
      );
      wrap.append(button('Replace tracker', () => callbacks.replace(v.id)));
    }

    actions.append(wrap);
    row.append(actions);
    table.append(row);
  }

  if (!items.length) {
    const tr = element('tr');
    const td = element('td', 'No vehicles yet. Add a vehicle to begin.');

    td.colSpan = 6;
    tr.append(td);
    table.append(tr);
  }
}
