import { Router } from 'express';

export function healthRoutes() {
  const r = Router();

  for (const path of ['/health/live', '/health/ready']) {
    r.get(path, (_req, res) => {
      res.json({ ok: true });
    });
  }

  return r;
}
