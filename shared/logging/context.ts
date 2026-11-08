import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { TraceContext } from '../contracts/tracing.js';

export type LogContext = TraceContext & {
  requestId?: string;
  ingestionEventId?: string;
  outboxId?: string;
  logId?: string;
  sessionId?: string;
  deviceId?: string;
};

export const logContext = new AsyncLocalStorage<LogContext>();

export function newTrace(): TraceContext {
  return { traceId: randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex') };
}

export function childContext(parent: TraceContext): TraceContext & { parentSpanId: string } {
  return {
    traceId: parent.traceId,
    spanId: randomBytes(8).toString('hex'),
    parentSpanId: parent.spanId,
  };
}

export function parseTraceparent(value: string | undefined): TraceContext | undefined {
  const match = /^00-((?!0{32})[a-f0-9]{32})-((?!0{16})[a-f0-9]{16})-0[01]$/.exec(value ?? '');

  return match ? { traceId: match[1]!, spanId: match[2]! } : undefined;
}

export function traceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-01`;
}
