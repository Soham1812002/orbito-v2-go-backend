import { childContext, logContext, newTrace, traceparent } from '../logging/context.js';
import { logger } from '../logging/logger.js';

export async function internalPost(url: string, secret: string, body: unknown) {
  const context = {
    ...logContext.getStore(),
    ...childContext(logContext.getStore() ?? newTrace()),
  };
  const started = performance.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        traceparent: traceparent(context),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    logger.debug(
      {
        ...context,
        event: 'http.internal.completed',
        statusCode: response.status,
        durationMs: Math.round(performance.now() - started),
        outcome: response.ok ? 'success' : 'failure',
      },
      'Internal HTTP request completed',
    );

    if (!response.ok) {
      throw new Error(`Internal request failed: ${response.status}`);
    }

    return (await response.json()) as unknown;
  } catch (err) {
    logger.warn(
      {
        ...context,
        event: 'http.internal.failed',
        outcome: 'failure',
        err,
        durationMs: Math.round(performance.now() - started),
      },
      'Internal HTTP request failed',
    );
    throw err;
  }
}
