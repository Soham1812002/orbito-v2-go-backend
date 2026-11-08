import { childContext, logContext, newTrace } from '../../../../shared/logging/context.js';
import { Router } from 'express';
import { realtimeEvent } from '../../../../shared/contracts/identity.js';
import type { RealtimeEvent } from '../../../../shared/contracts/identity.js';
import { serviceAuth } from '../../../../shared/http/service-auth.js';

export function eventRoutes(secret: string, fanout: (event: RealtimeEvent) => Promise<void>) {
  const r = Router();

  r.post('/internal/v1/events', serviceAuth(secret), async (req, res) => {
    const event = realtimeEvent.parse(req.body);
    const requestContext = logContext.getStore();
    const context =
      requestContext && requestContext.traceId === event.trace?.traceId
        ? requestContext
        : (event.trace ?? requestContext ?? newTrace());

    await logContext.run(
      {
        ...childContext(context),
        ingestionEventId: event.ingestionEventId,
        outboxId: event.eventId,
        logId: event.logId,
        deviceId: event.deviceId,
      },
      () => fanout(event),
    );
    res.json({ accepted: true });
  });

  return r;
}
