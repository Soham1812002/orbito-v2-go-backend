import { Router } from 'express';
import { z } from 'zod';
import { currentActor } from '../../http/current-actor.js';
import { admin } from '../auth/auth.middleware.js';
import { assignmentInput } from './assignments.schemas.js';
import type { AssignmentService } from './assignments.service.js';

const id = z.string().uuid();

export function assignmentRoutes(service: AssignmentService) {
  const r = Router();

  r.post('/vehicles/:id/device-assignment', admin, async (req, res) => {
    await service.replace(
      currentActor(res),
      id.parse(req.params.id),
      assignmentInput.parse(req.body),
    );
    res.json({ ok: true });
  });

  return r;
}
