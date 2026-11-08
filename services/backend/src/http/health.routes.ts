import { Router } from 'express';

export function healthRoutes(check: () => Promise<void>) {
  const r = Router();

  r.get('/health/live', (_req, res) => {
    res.json({ ok: true });
  });
  r.get('/health/ready', async (_req, res) => {
    await check();
    res.json({ ok: true });
  });

  return r;
}
