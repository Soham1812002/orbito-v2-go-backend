import express from 'express';
import { fileURLToPath } from 'node:url';
import { rateLimit } from 'express-rate-limit';
import type { Config } from './config/env.js';
import type { BackendServices } from './application/backend.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { sessionLookup, requireUser, csrf } from './modules/auth/auth.middleware.js';
import { vehicleRoutes } from './modules/vehicles/vehicles.routes.js';
import { deviceRoutes } from './modules/devices/devices.routes.js';
import { assignmentRoutes } from './modules/assignments/assignments.routes.js';
import { gatewayRoutes } from './modules/ingestion/ingestion.routes.js';
import { logRoutes } from './modules/device-logs/logs.routes.js';
import {
  ticketRoutes,
  realtimeAuthRoutes,
} from './modules/realtime-access/realtime-access.routes.js';
import { errors } from '../../../shared/http/errors.js';
import { requestId } from '../../../shared/http/request-id.js';
import { serviceAuth } from '../../../shared/http/service-auth.js';
import { securityHeaders } from './http/security-headers.js';
import { healthRoutes } from './http/health.routes.js';
import { pageRoutes } from './http/pages.routes.js';

export function createApp(services: BackendServices, config: Config) {
  const app = express();

  app.disable('x-powered-by');
  if (config.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }

  app.set('view engine', 'ejs');
  app.set('views', fileURLToPath(new URL('./views/', import.meta.url)));
  app.use(requestId, express.json({ limit: '64kb' }));
  app.use(securityHeaders(config.NODE_ENV === 'production'));
  app.use(healthRoutes(services.health));
  app.use('/internal/v1', serviceAuth(config.GATEWAY_SECRET), gatewayRoutes(services.ingestion));
  // Mount realtime endpoints on a separate path to avoid applying gateway credentials to them.
  app.use(
    '/internal/realtime/v1',
    serviceAuth(config.REALTIME_SECRET),
    realtimeAuthRoutes(services.realtimeAccess),
  );
  // Host development serves compiled browser modules; Docker keeps them beside the server.
  app.use(
    '/assets',
    express.static(
      fileURLToPath(new URL('../../../dist/services/backend/src/public/', import.meta.url)),
    ),
  );
  app.use('/assets', express.static(fileURLToPath(new URL('./public/', import.meta.url))));
  app.use(
    '/assets/socket.io',
    express.static(
      fileURLToPath(new URL('../../../node_modules/socket.io-client/dist/', import.meta.url)),
    ),
  );
  app.use(sessionLookup(services.auth));
  app.use(authRoutes(services.auth, config));
  app.use(pageRoutes());
  app.use(
    '/api/v1',
    rateLimit({ windowMs: 60000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }),
    requireUser,
    csrf(config.PUBLIC_ORIGIN),
    vehicleRoutes(services.vehicles),
    deviceRoutes(services.devices),
    assignmentRoutes(services.assignments),
    logRoutes(services.logs),
    ticketRoutes(services.realtimeAccess),
  );
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use(errors);

  return app;
}
