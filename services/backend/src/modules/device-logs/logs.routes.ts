import { Router } from 'express';
import { z } from 'zod';
import { logQuery } from '../../../../../shared/contracts/logs.js';
import { currentActor } from '../../http/current-actor.js';
import type { LogService } from './logs.service.js';

const id = z.string().uuid();

export function logRoutes(service: LogService) {
  const r = Router();

  r.get('/device-logs', async (req, res) => {
    res.json(await service.list(currentActor(res), logQuery.parse(req.query)));
  });
  r.get('/device-logs/:id', async (req, res) => {
    res.json(await service.detail(currentActor(res), id.parse(req.params.id)));
  });

  return r;
}
