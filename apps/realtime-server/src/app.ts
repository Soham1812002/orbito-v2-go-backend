import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { z } from 'zod';
import {
  serviceAuth,
  errors,
  internalPost,
  logger,
} from '../../../packages/server-common/src/http.js';
export function createRealtime(config: { apiUrl: string; secret: string; origin: string }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  const server = createServer(app);
  const io = new Server(server, {
    cors: { origin: config.origin, credentials: true },
    maxHttpBufferSize: 16384,
    // Browsers can omit Origin on same-origin polling GETs. The socket still
    // requires a single-use ticket; an explicitly foreign Origin is rejected.
    allowRequest: (req, callback) =>
      callback(null, req.headers.origin === undefined || req.headers.origin === config.origin),
  });
  const authorize = (sessionHash: string) =>
    internalPost(`${config.apiUrl}/internal/realtime/v1/subscriptions/authorize`, config.secret, {
      sessionHash,
    });
  io.use(async (socket, next) => {
    try {
      const ticket = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(socket.handshake.auth.ticket);
      const identity = await internalPost(
        `${config.apiUrl}/internal/realtime/v1/realtime-tickets/consume`,
        config.secret,
        { ticket },
      );
      socket.data.identity = identity;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    const identity = socket.data.identity;
    void socket.join(`org:${identity.organization_id}:devices`);
    const timer = setInterval(() => {
      void authorize(identity.session_hash)
        .then((current) => {
          if (current.organization_id !== identity.organization_id || current.id !== identity.id)
            socket.disconnect(true);
        })
        .catch(() => socket.disconnect(true));
    }, 30000);
    socket.on('disconnect', () => clearInterval(timer));
  });
  app.get('/health/live', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/health/ready', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/internal/v1/events', serviceAuth(config.secret), async (req, res) => {
    const event = z
      .object({
        eventId: z.string().uuid(),
        organizationId: z.string().uuid(),
        deviceId: z.string().uuid(),
        logId: z.string().uuid(),
      })
      .strict()
      .parse(req.body);
    // Revalidate before each fanout as well as periodically: revoked sessions cannot receive a new log notification.
    const sockets = await io.in(`org:${event.organizationId}:devices`).fetchSockets();
    await Promise.all(
      sockets.map(async (socket) => {
        try {
          const current = await authorize(socket.data.identity.session_hash);
          if (current.organization_id !== event.organizationId) {
            socket.disconnect(true);
            return;
          }
          socket.emit('device:log', {
            eventId: event.eventId,
            deviceId: event.deviceId,
            logId: event.logId,
          });
        } catch {
          socket.disconnect(true);
        }
      }),
    );
    res.json({ accepted: true });
  });
  app.use(errors);
  return { server, io };
}
