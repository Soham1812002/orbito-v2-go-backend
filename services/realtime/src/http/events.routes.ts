import { Router } from 'express';
import { realtimeEvent } from '../../../../shared/contracts/identity.js';
import type { RealtimeEvent } from '../../../../shared/contracts/identity.js';
import { serviceAuth } from '../../../../shared/http/service-auth.js';

export function eventRoutes(secret: string, fanout: (event: RealtimeEvent) => Promise<void>) {
  const r = Router();

  r.post('/internal/v1/events', serviceAuth(secret), async (req, res) => {
    await fanout(realtimeEvent.parse(req.body));
    res.json({ accepted: true });
  });

  return r;
}
