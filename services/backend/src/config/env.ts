import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  PUBLIC_ORIGIN: z.string().url().default('http://localhost:3000'),
  PORT: z.coerce.number().int().default(3000),
  GATEWAY_SECRET: z.string().min(32),
  REALTIME_SECRET: z.string().min(32),
  REALTIME_URL: z.string().url().default('http://localhost:3001'),
  SESSION_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  ALLOW_UNVERIFIED_MARKON: z.enum(['true', 'false']).default('false'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
});

export type Config = z.infer<typeof schema>;

export const readConfig = (env: NodeJS.ProcessEnv = process.env) => {
  const config = schema.parse(env);

  if (
    config.GATEWAY_SECRET === config.REALTIME_SECRET ||
    [config.GATEWAY_SECRET, config.REALTIME_SECRET].some((s) => s.startsWith('replace-'))
  ) {
    throw new Error('Set independent random gateway and realtime secrets');
  }

  if (config.NODE_ENV === 'production' && !config.PUBLIC_ORIGIN.startsWith('https://')) {
    throw new Error('Production PUBLIC_ORIGIN must use HTTPS');
  }

  return config;
};
