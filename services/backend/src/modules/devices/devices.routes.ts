import { Router } from 'express';
import { z } from 'zod';
import { profiles } from '../../../../../shared/contracts/fleet.js';
import { currentActor } from '../../http/current-actor.js';
import { admin } from '../auth/auth.middleware.js';
import type { DeviceService } from './devices.service.js';

const id = z.string().uuid();
const patch = z.object({ enabled: z.boolean() }).strict();

export function deviceRoutes(service: DeviceService) {
  const r = Router();

  r.get('/profiles', (_req, res) => {
    res.json({ items: profiles });
  });
  r.get('/devices', async (_req, res) => {
    res.json({ items: await service.list(currentActor(res)) });
  });
  r.patch('/devices/:id', admin, async (req, res) => {
    await service.setEnabled(
      currentActor(res),
      id.parse(req.params.id),
      patch.parse(req.body).enabled,
    );
    res.json({ ok: true });
  });

  return r;
}
