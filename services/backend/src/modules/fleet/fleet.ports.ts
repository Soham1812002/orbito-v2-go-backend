import type { PreparedDevice } from '../devices/device-registration.js';
import type { VehicleInput, VehiclePatch } from '../../../../../shared/contracts/fleet.js';
import type { Device, Vehicle } from '../../../../../shared/contracts/console.js';

export type VehicleRow = Omit<Vehicle, 'last_received_at'> & { last_received_at: Date | null };

export type DeviceInput = Pick<
  VehicleInput,
  'imei' | 'profileId' | 'model' | 'firmware' | 'expectedInterval'
> & { enabled?: boolean };

export interface VehicleReader {
  list(org: string, q: string, offset: number): Promise<VehicleRow[]>;
}

export interface DeviceReader {
  list(org: string): Promise<Device[]>;
}

export interface FleetTransaction {
  vehicles: {
    create(
      id: string,
      org: string,
      input: VehicleInput & { registrationKey: string },
    ): Promise<void>;
    exists(org: string, id: string): Promise<boolean>;
    update(
      org: string,
      id: string,
      input: VehiclePatch & { registrationKey?: string },
    ): Promise<void>;
  };
  devices: {
    create(id: string, org: string, input: PreparedDevice): Promise<void>;
    setEnabled(org: string, id: string, enabled: boolean): Promise<boolean>;
    enabledExists(org: string, id: string): Promise<boolean>;
  };
  assignments: {
    lock(): Promise<void>;
    create(
      id: string,
      org: string,
      device: string,
      vehicle: string,
      effectiveAt?: string,
    ): Promise<void>;
    isAssigned(device: string): Promise<boolean>;
    close(vehicle: string, effectiveAt: string): Promise<void>;
    resetState(org: string, vehicle: string): Promise<void>;
  };
  audit: {
    record(
      org: string,
      actor: string,
      action: string,
      target: string,
      changes: unknown,
    ): Promise<void>;
  };
}

export type FleetTransactionRunner = <T>(
  work: (context: FleetTransaction) => Promise<T>,
) => Promise<T>;
