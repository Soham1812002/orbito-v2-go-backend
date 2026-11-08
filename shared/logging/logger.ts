import pino from 'pino';
import { logContext } from './context.js';

const safeFields = new Set([
  'event',
  'outcome',
  'traceId',
  'spanId',
  'parentSpanId',
  'requestId',
  'ingestionEventId',
  'outboxId',
  'logId',
  'deviceId',
  'sessionId',
  'attempt',
  'durationMs',
  'method',
  'route',
  'statusCode',
  'protocol',
  'profile',
  'packetType',
  'recipients',
  'port',
  'migration',
  'errorCode',
  'errorType',
  'retryable',
  'reason',
  'socketId',
  'duplicate',
  'count',
]);

// Never serialize request bodies, SQL values or arbitrary error messages.
export function safeLogFields(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (key === 'err' || key === 'error') {
      output.errorType = value instanceof Error ? value.constructor.name : 'UnknownError';
      const code = (value as { code?: unknown } | null)?.code;

      if (typeof code === 'string' && /^[a-zA-Z0-9_]{1,40}$/.test(code)) {
        output.errorCode = code;
      }
    } else if (safeFields.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) {
      output[key] = typeof value === 'string' ? value.slice(0, 200) : value;
    }
  }

  return output;
}

export function createLogger(service: string, destination?: pino.DestinationStream) {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? 'trace',
      base: { schemaVersion: 1, service, environment: process.env.NODE_ENV ?? 'development' },
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      messageKey: 'message',
      formatters: {
        level: (label) => ({ level: label }),
        log: (fields) => safeLogFields({ ...logContext.getStore(), ...fields }),
      },
      mixin: (_context, level) => ({
        event: 'application.log',
        outcome: level >= 50 ? 'failure' : 'success',
      }),
    },
    destination,
  );
}

export const logger = createLogger(process.env.SERVICE_NAME ?? 'backend');
