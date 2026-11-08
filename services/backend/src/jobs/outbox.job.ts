import type { OutboxStore } from '../modules/outbox/outbox.ports.js';
import type { RealtimeEvent } from '../../../../shared/contracts/identity.js';

export function createOutboxJob(deps: {
  store: OutboxStore;
  send: (event: RealtimeEvent) => Promise<unknown>;
  warn: (error: unknown, id: string) => void;
}) {
  return async () => {
    const entries = await deps.store.claim();

    for (const row of entries) {
      try {
        await deps.send({
          eventId: row.id,
          organizationId: row.organization_id,
          deviceId: row.device_id,
          logId: row.log_id,
        });
        await deps.store.delivered(row.id);
      } catch (err) {
        deps.warn(err, row.id);
        await deps.store.retry(row.id);
      }
    }
  };
}
