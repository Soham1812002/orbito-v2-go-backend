import { query, element } from '../shared/dom.js';
import { message, errorText } from '../shared/messages.js';
import { loadDevices } from '../shared/catalog.js';
import { loadLogs, requestTicket } from './api.js';
import { renderLogs } from './table.js';
import { showLogDetail } from './details.js';
import { liveConnection } from './live.js';

export async function startLogPage() {
  const form = query<HTMLFormElement>('#filters');

  const table = query<HTMLTableSectionElement>('#logs');

  let cursor: string | null = null;

  let nextCursor: string | null = null;

  let live = true;

  let loading = false;

  let pending = false;

  let requestGeneration = 0;

  const dateInput = (d: Date) => d.toISOString().slice(0, 16);

  query<HTMLInputElement>('[name="from"]', form).value = dateInput(new Date(Date.now() - 86400000));

  query<HTMLInputElement>('[name="to"]', form).value = dateInput(new Date());

  function parameters() {
    const query = new URLSearchParams();

    for (const [key, value] of new FormData(form)) {
      if (typeof value !== 'string' || !value) {
        continue;
      }

      query.set(
        key,
        key === 'from' || key === 'to' ? new Date(`${value}:00Z`).toISOString() : value,
      );
    }

    if (cursor) {
      query.set('cursor', cursor);
    }

    return query;
  }

  async function load() {
    if (loading) {
      pending = true;

      return;
    }

    loading = true;
    const generation = ++requestGeneration;

    try {
      const data = await loadLogs(parameters());

      if (generation !== requestGeneration) {
        return;
      }

      nextCursor = data.nextCursor;
      renderLogs(table, data.items, showLogDetail);
      query('#log-count').textContent = `${data.items.length} saved messages`;
      query('#older').hidden = !nextCursor;
    } catch (e) {
      message(errorText(e));
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
    query<HTMLInputElement>('[name="to"]', form).value = dateInput(new Date(Date.now() + 60000));
    void load();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    live = false;
    updateLive();
    cursor = null;
    void load();
  });

  query('#older').addEventListener('click', () => {
    live = false;
    cursor = nextCursor;
    updateLive();
    void load();
  });

  query('#newest').addEventListener('click', () => {
    live = true;
    updateLive();
    newest();
  });

  query('#toggle-live').addEventListener('click', () => {
    live = !live;
    updateLive();
    if (live) {
      newest();
    }
  });

  query('#close-detail').addEventListener('click', () =>
    query<HTMLDialogElement>('#log-detail').close(),
  );

  function updateLive() {
    query('#toggle-live').textContent = live ? 'Pause live' : 'Resume live';
    query('#live-note').textContent = live
      ? 'Live: saved messages refresh automatically.'
      : 'Paused: ingestion continues. Resume to reload newest messages.';
  }

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleRefresh() {
    if (!live) {
      return;
    }

    if (refreshTimer) {
      return;
    }

    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      newest();
    }, 500);
  }

  const devices = await loadDevices();

  for (const device of devices) {
    const option = element('option', `${device.imei} — ${device.model}`);

    option.value = device.id;
    query('#device-filter').append(option);
  }

  const selected = new URLSearchParams(location.search).get('deviceId');

  if (selected) {
    query<HTMLSelectElement>('[name="deviceId"]', form).value = selected;
  }

  const connection = liveConnection(requestTicket, {
    connected: () => {
      query('#connection').textContent = 'Live connected';
      if (live) {
        newest();
      }
    },
    disconnected: (unavailable) => {
      query('#connection').textContent = unavailable
        ? 'Connection unavailable'
        : 'Disconnected · retrying';
    },
    log: scheduleRefresh,
    error: (error) => message(errorText(error)),
  });

  window.addEventListener(
    'pagehide',
    () => {
      connection.dispose();
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
    },
    { once: true },
  );
  await load();
  await connection.start();
}
