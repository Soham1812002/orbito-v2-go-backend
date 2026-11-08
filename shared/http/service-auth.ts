import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { childContext, logContext, parseTraceparent } from '../logging/context.js';

export const serviceAuth =
  (secret: string): RequestHandler =>
  (req, res, next) => {
    const actual = Buffer.from(req.get('authorization') ?? '');
    const expected = Buffer.from(`Bearer ${secret}`);

    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.status(401).json({ error: 'Unauthorized service' });

      return;
    }

    const parent = parseTraceparent(req.get('traceparent'));

    if (parent) {
      const current = logContext.getStore();
      const context = { ...current, ...childContext(parent) };

      res.setHeader('X-Trace-ID', context.traceId);
      // Mutate only this request's context so the completion callback sees the accepted trace.
      if (current) {
        Object.assign(current, context);
      }

      logContext.run(context, next);
    } else {
      next();
    }
  };
