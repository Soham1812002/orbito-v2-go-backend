import pino from 'pino';

export const logger = pino({ redact: ['req.headers.authorization', 'password', 'token', 'raw'] });
