import { ZodError } from 'zod';
import type { ErrorRequestHandler } from 'express';
import { HttpError } from './http-error.js';
import type { ErrorCode } from '../errors/application-error.js';
import { ApplicationError } from '../errors/application-error.js';
import { logger } from '../logging/logger.js';

const errorStatus: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_input: 422,
};

export const errors: ErrorRequestHandler = (err, req, res, _next) => {
  const code = (err as { code?: string }).code;
  const bodyStatus =
    typeof err.status === 'number' && [400, 413].includes(err.status) ? err.status : undefined;
  const status =
    err instanceof ZodError
      ? 422
      : err instanceof ApplicationError
        ? errorStatus[err.code]
        : err instanceof HttpError
          ? err.status
          : (bodyStatus ?? (code === '23505' || code === '23P01' ? 409 : 500));

  if (status === 500) {
    logger.error({ err, requestId: res.locals.requestId }, 'Request failed');
  }

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
