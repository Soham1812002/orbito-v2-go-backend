import type { RequestHandler } from 'express';
import { vehicleInput, vehiclePatch } from '../../../../../shared/contracts/fleet.js';
import { currentActor } from '../../http/current-actor.js';
import { vehicleId, vehicleSearch } from './vehicles.schemas.js';
import type { VehicleService } from './vehicles.service.js';

export function vehicleController(service: VehicleService) {
  return {
    list: (async (req, res) => {
      const q = vehicleSearch.parse(req.query);

      res.json(await service.list(currentActor(res), q.q, q.offset));
    }) satisfies RequestHandler,
    register: (async (req, res) => {
      res.status(201).json(await service.register(currentActor(res), vehicleInput.parse(req.body)));
    }) satisfies RequestHandler,
    update: (async (req, res) => {
      await service.update(
        currentActor(res),
        vehicleId.parse(req.params.id),
        vehiclePatch.parse(req.body),
      );
      res.json({ ok: true });
    }) satisfies RequestHandler,
  };
}
