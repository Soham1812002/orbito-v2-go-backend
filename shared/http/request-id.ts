import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { logContext, newTrace } from '../logging/context.js';
import { logger } from '../logging/logger.js';

export const requestId: RequestHandler = (req, res, next) => {
  const proxyId = req.get('x-request-id');

  res.locals.requestId = proxyId && /^[a-f0-9]{32}$/.test(proxyId) ? proxyId : randomUUID();
  res.setHeader('X-Request-ID', res.locals.requestId);
  const context = { ...newTrace(), requestId: res.locals.requestId as string };
  const started = performance.now();

  logContext.run(context, () => {
    res.setHeader('X-Trace-ID', context.traceId);
    const complete = (aborted: boolean) => {
      const fields = {
        ...context,
        event: 'http.completed',
        method: req.method,
        route: String(req.route?.path ?? 'unmatched'),
        statusCode: res.statusCode,
        durationMs: Math.round(performance.now() - started),
        outcome: aborted ? 'failure' : res.statusCode >= 400 ? 'rejected' : 'success',
      };

      if (aborted || res.statusCode >= 500) {
        logger.error(fields, 'HTTP request failed');
      } else if (res.statusCode >= 400) {
        logger.warn(fields, 'HTTP request rejected');
      } else {
        logger.debug(fields, 'HTTP request completed');
      }
    };

    res.once('finish', () => complete(false));
    res.once('close', () => {
      if (!res.writableFinished) {
        complete(true);
      }
    });
    next();
  });
};
