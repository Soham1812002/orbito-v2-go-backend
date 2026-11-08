import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { errors } from '../../../shared/http/errors.js';
import type { BackendClient } from './clients/backend.client.js';
import type { ClientEvents, ServerEvents, SocketData } from './sockets/types.js';
import { authenticateSockets } from './sockets/auth.middleware.js';
import { socketConnections } from './sockets/fanout.adapter.js';
import { createFanoutService } from './services/fanout.service.js';
import { eventRoutes } from './http/events.routes.js';
import { healthRoutes } from './http/health.routes.js';

export function createRealtime(client: BackendClient, config: { secret: string; origin: string }) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  const server = createServer(app);
  const io = new Server<ClientEvents, ServerEvents, ClientEvents, SocketData>(server, {
    cors: { origin: config.origin, credentials: true },
    maxHttpBufferSize: 16384,
    allowRequest: (req, callback) =>
      callback(null, req.headers.origin === undefined || req.headers.origin === config.origin),
  });

  authenticateSockets(io, client);
  app.use(healthRoutes());
  app.use(
    eventRoutes(
      config.secret,
      createFanoutService({
        connections: socketConnections(io),
        authorize: (hash) => client.authorize(hash),
      }),
    ),
  );
  app.use(errors);

  return { server, io };
}
