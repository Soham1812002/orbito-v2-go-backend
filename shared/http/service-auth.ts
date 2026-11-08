import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

export const serviceAuth =
  (secret: string): RequestHandler =>
  (req, res, next) => {
    const actual = Buffer.from(req.get('authorization') ?? '');
    const expected = Buffer.from(`Bearer ${secret}`);

    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.status(401).json({ error: 'Unauthorized service' });

      return;
    }

    next();
  };
