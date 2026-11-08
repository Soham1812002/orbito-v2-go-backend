import { Router } from 'express';
import { HttpError } from '../../../../../shared/http/http-error.js';
import type { IngestionService } from './ingestion.service.js';

export function gatewayRoutes(service: IngestionService) {
  const r = Router();

  r.get('/device-registry', async (req, res) => {
    const imei = typeof req.query.imei === 'string' ? req.query.imei : null;

    if (imei && !/^\d{15}$/.test(imei)) {
      throw new HttpError(422, 'Invalid IMEI');
    }

    res.json(await service.registry(imei));
  });
  r.post('/events', async (req, res) => {
    res.json(await service.ingest(req.body));
  });

  return r;
}
