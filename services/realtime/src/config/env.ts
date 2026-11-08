import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  API_URL: z.string().url().default('http://localhost:3000'),
  REALTIME_SECRET: z.string().min(32),
  PUBLIC_ORIGIN: z.string().url(),
  REALTIME_PORT: z.coerce.number().default(3001),
});

export const readRealtimeConfig = (env: NodeJS.ProcessEnv = process.env) => schema.parse(env);

export type RealtimeConfig = ReturnType<typeof readRealtimeConfig>;
