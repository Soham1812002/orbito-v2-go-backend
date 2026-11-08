import { Router } from 'express';
import { ticketInput, authorizationInput } from '../../../../../shared/contracts/identity.js';
import { currentActor } from '../../http/current-actor.js';
import type { RealtimeAccessService } from './realtime-access.service.js';

export function ticketRoutes(service: RealtimeAccessService) {
  const r = Router();

  r.post('/realtime-ticket', async (_req, res) => {
    res.json(await service.issue(currentActor(res).session_hash));
  });

  return r;
}

export function realtimeAuthRoutes(service: RealtimeAccessService) {
  const r = Router();

  r.post('/realtime-tickets/consume', async (req, res) => {
    res.json(await service.consume(ticketInput.parse(req.body).ticket));
  });
  r.post('/subscriptions/authorize', async (req, res) => {
    res.json(await service.authorize(authorizationInput.parse(req.body).sessionHash));
  });

  return r;
}
