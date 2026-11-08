import { createHash } from 'node:crypto';
import type { DecodedEvent } from '../../../../../shared/contracts/events.js';
import { ApplicationError } from '../../../../../shared/errors/application-error.js';
import type { RegisteredDevice } from './ingestion.ports.js';

export function fingerprint(e: DecodedEvent) {
  const stable =
    e.deviceTimestamp && e.source.sequence
      ? `${e.deviceTimestamp}:${e.source.sequence}`
      : `${e.source.sessionId}:${e.eventId}`;

  return createHash('sha256')
    .update(
      `${e.deviceIdentifier}:${e.protocol}:${e.profile}:${e.packetType}:${stable}:${e.source.rawSha256}`,
    )
    .digest('hex');
}

export function assertDeviceAdmission(
  e: DecodedEvent,
  d: RegisteredDevice,
  allowUnverified: boolean,
) {
  if (d.profile_id !== e.profile || d.protocol !== e.protocol) {
    throw new ApplicationError('conflict', 'Device profile mismatch');
  }

  if (
    e.validation.decodeStatus === 'DECODED' &&
    e.validation.checksum === 'UNVERIFIED' &&
    !allowUnverified
  ) {
    throw new ApplicationError('invalid_input', 'Unverified checksum admission disabled');
  }

  if (
    e.validation.decodeStatus === 'DECODED' &&
    e.protocol === 'CONCOX' &&
    e.validation.checksum !== 'VALID'
  ) {
    throw new ApplicationError('invalid_input', 'Concox requires valid CRC');
  }
}
