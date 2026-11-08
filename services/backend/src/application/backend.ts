import type { AuthService } from '../modules/auth/auth.service.js';
import type { VehicleService } from '../modules/vehicles/vehicles.service.js';
import type { DeviceService } from '../modules/devices/devices.service.js';
import type { AssignmentService } from '../modules/assignments/assignments.service.js';
import type { LogService } from '../modules/device-logs/logs.service.js';
import type { IngestionService } from '../modules/ingestion/ingestion.service.js';
import type { RealtimeAccessService } from '../modules/realtime-access/realtime-access.service.js';

export interface BackendServices {
  auth: AuthService;
  vehicles: VehicleService;
  devices: DeviceService;
  assignments: AssignmentService;
  logs: LogService;
  ingestion: IngestionService;
  realtimeAccess: RealtimeAccessService;
  health: () => Promise<void>;
}
