import 'dotenv/config';
import { z } from 'zod';
import { createRealtime } from './app.js';
import { logger } from '../../../packages/server-common/src/http.js';
{
  const env = z
    .object({
      API_URL: z.string().url().default('http://localhost:3000'),
      REALTIME_SECRET: z.string().min(32),
      PUBLIC_ORIGIN: z.string().url(),
      REALTIME_PORT: z.coerce.number().default(3001),
    })
    .parse(process.env);
  const { server, io } = createRealtime({
    apiUrl: env.API_URL,
    secret: env.REALTIME_SECRET,
    origin: env.PUBLIC_ORIGIN,
  });
  server.listen(env.REALTIME_PORT, '0.0.0.0', () =>
    logger.info({ port: env.REALTIME_PORT }, 'Realtime listening'),
  );
  const stop = () => {
    io.close();
    server.close();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
