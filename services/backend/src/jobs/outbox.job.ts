import { childContext, logContext, newTrace } from '../../../../shared/logging/context.js';
import { logger } from '../../../../shared/logging/logger.js';
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
      const parent =
        row.trace_id && row.span_id ? { traceId: row.trace_id, spanId: row.span_id } : newTrace();

      await logContext.run(
        {
          ...childContext(parent),
          outboxId: row.id,
          ingestionEventId: row.ingestion_event_id ?? undefined,
          logId: row.log_id,
          deviceId: row.device_id,
        },
        async () => {
          try {
            logger.debug(
              { event: 'outbox.delivery.started', attempt: (row.attempts ?? 0) + 1 },
              'Delivering persisted notification',
            );
            await deps.send({
              eventId: row.id,
              ingestionEventId: row.ingestion_event_id ?? undefined,
              trace: logContext.getStore(),
              organizationId: row.organization_id,
              deviceId: row.device_id,
              logId: row.log_id,
            });
            await deps.store.delivered(row.id);
            logger.info({ event: 'outbox.delivered' }, 'Realtime accepted notification');
          } catch (err) {
            logger.warn(
              { event: 'outbox.retry', outcome: 'retry', err, attempt: (row.attempts ?? 0) + 1 },
              'Realtime delivery will retry',
            );
            deps.warn(err, row.id);
            await deps.store.retry(row.id);
          }
        },
      );
    }
  };
}
