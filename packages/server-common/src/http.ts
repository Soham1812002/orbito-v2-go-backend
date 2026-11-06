import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { RequestHandler, ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import pino from 'pino';
export const logger = pino({ redact: ['req.headers.authorization', 'password', 'token', 'raw'] });
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
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
export const requestId: RequestHandler = (req, res, next) => {
  res.locals.requestId = randomUUID();
  res.setHeader('X-Request-ID', res.locals.requestId);
  next();
};
export const errors: ErrorRequestHandler = (err, req, res, _next) => {
  const code = (err as { code?: string }).code;
  const bodyStatus =
    typeof err.status === 'number' && [400, 413].includes(err.status) ? err.status : undefined;
  const status =
    err instanceof ZodError
      ? 422
      : err instanceof HttpError
        ? err.status
        : (bodyStatus ?? (code === '23505' || code === '23P01' ? 409 : 500));
  if (status === 500) logger.error({ err, requestId: res.locals.requestId }, 'Request failed');
  res.status(status).json({
    error:
      status === 500
        ? 'Internal server error'
        : status === 409
          ? 'IMEI, vehicle number or assignment already exists'
          : err.message,
    details: err instanceof ZodError ? err.flatten() : undefined,
    requestId: res.locals.requestId,
  });
};
export async function internalPost(url: string, secret: string, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Internal request failed: ${response.status}`);
  return response.json();
}
