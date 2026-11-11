import { z } from 'zod';
import { ApplicationError } from '../../../../../shared/errors/application-error.js';
import type { LogCursor } from './logs.ports.js';

const schema = z.object({ time: z.string().datetime(), id: z.string().uuid() });

export function decodeCursor(cursor: string): LogCursor {
  let value: unknown;

  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    throw new ApplicationError('invalid_input', 'Invalid cursor');
  }

  return schema.parse(value);
}

export function encodeCursor(time: Date | string, id: string) {
  return Buffer.from(
    JSON.stringify({ time: typeof time === 'string' ? time : time.toISOString(), id }),
  ).toString('base64url');
}
