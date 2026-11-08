import type { DecodedEvent } from '../../../../../shared/contracts/events.js';

export interface RegisteredDevice {
  id: string;
  organization_id: string;
  profile_id: string;
  protocol: string;
}

export interface IngestionTransaction {
  lockAssignments(): Promise<void>;
  findDevice(imei: string): Promise<RegisteredDevice | undefined>;
  addReceipt(e: DecodedEvent, d: RegisteredDevice, fingerprint: string): Promise<boolean>;
  findAssignment(device: string, time: string | null): Promise<string | null>;
  saveLog(
    e: DecodedEvent,
    d: RegisteredDevice,
    vehicleId: string | null,
    logId: string,
  ): Promise<void>;
  updateActivity(device: string, received: string): Promise<void>;
  savePoint(
    e: DecodedEvent,
    d: RegisteredDevice,
    vehicleId: string | null,
    point: NonNullable<DecodedEvent['location']>,
  ): Promise<void>;
  currentVehicle(device: string): Promise<string | undefined>;
  updateCommunication(vehicle: string, d: RegisteredDevice, received: string): Promise<void>;
  updatePosition(
    vehicle: string,
    point: NonNullable<DecodedEvent['location']>,
    time: string | null,
  ): Promise<void>;
  updateIgnition(vehicle: string, ignition: boolean, time: string): Promise<void>;
  enqueue(d: RegisteredDevice, log: string): Promise<void>;
}

export interface RegistryEntry {
  imei: string;
  profile: string;
  enabled: boolean;
}

export interface IngestionDependencies {
  inTransaction: <T>(work: (tx: IngestionTransaction) => Promise<T>) => Promise<T>;
  registry: (imei: string | null) => Promise<RegistryEntry[]>;
  allowUnverified: boolean;
  now: () => number;
  newId: () => string;
}
