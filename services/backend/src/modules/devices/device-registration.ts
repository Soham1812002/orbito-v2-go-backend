import { profiles } from '../../../../../shared/contracts/fleet.js';
import { ApplicationError } from '../../../../../shared/errors/application-error.js';
import type { DeviceInput } from '../fleet/fleet.ports.js';

export function prepareDevice(input: DeviceInput) {
  const profile = profiles.find((p) => p.id === input.profileId);

  if (!profile) {
    throw new ApplicationError('invalid_input', 'Unsupported device profile');
  }

  return {
    ...input,
    enabled: input.enabled ?? true,
    manufacturer: profile.manufacturer,
    protocol: profile.protocol,
  };
}

export type PreparedDevice = ReturnType<typeof prepareDevice>;
