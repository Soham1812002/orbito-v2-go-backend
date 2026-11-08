import { randomUUID } from 'node:crypto';
import { type DecodedEvent } from '../shared/contracts/events.js';

export function event(): DecodedEvent {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    deviceIdentifier: '358980100675496',
    protocol: 'CONCOX',
    profile: 'concox-v29-standard',
    packetType: '0x22',
    eventType: 'LOCATION',
    deviceTimestamp: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    historical: false,
    location: { latitude: 23.0225, longitude: 72.5714, speedKph: 45, headingDegrees: 120 },
    status: { ignition: true, gpsValid: true },
    validation: { decodeStatus: 'DECODED', checksum: 'VALID', warnings: [] },
    source: { sequence: '45', rawSha256: 'a'.repeat(64), sessionId: randomUUID() },
    protocolData: {},
  };
}
