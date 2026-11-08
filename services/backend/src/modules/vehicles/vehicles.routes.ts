import { Router } from 'express';
import type { VehicleService } from './vehicles.service.js';
import { vehicleController } from './vehicles.controller.js';
import { editor } from '../auth/auth.middleware.js';

export function vehicleRoutes(service: VehicleService) {
  const r = Router();
  const controller = vehicleController(service);

  r.get('/vehicles', controller.list);
  r.post('/vehicles', editor, controller.register);
  r.patch('/vehicles/:id', editor, controller.update);

  return r;
}
