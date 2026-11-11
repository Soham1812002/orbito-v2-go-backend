import test from 'node:test';
import assert from 'node:assert/strict';
import { decodedEvent } from '../shared/contracts/events.js';
import { event } from './fixtures.js';
import { decodeLog } from '../services/backend/src/browser/device-logs/api.js';
import { summarizeLog } from '../services/backend/src/browser/device-logs/summary.js';

const row = {
  id: 'log',
  received_at: new Date().toISOString(),
  device_time: null,
  vehicle_name: 'Test vehicle',
  registration_number: 'TEST',
  imei: '752533678900242',
  packet_type: '0x94',
  event_type: 'STATUS',
  protocol: 'CONCOX',
  historical: false,
  decode_status: 'DECODED',
  checksum_status: 'VALID',
  location: null,
  status: { externalPowerVoltage: 0 },
  protocol_data: {},
};

test('status contract accepts documented voltage without inventing a device timestamp or location', () => {
  const status = {
    ...event(),
    packetType: '0x94',
    eventType: 'STATUS',
    deviceTimestamp: null,
    location: null,
    status: { externalPowerVoltage: 11.83 },
  };
  const parsed = decodedEvent.parse(status);

  assert.equal(parsed.location, null);
  assert.equal(parsed.deviceTimestamp, null);
  assert.equal(parsed.status.externalPowerVoltage, 11.83);
  assert.throws(() => decodedEvent.parse({ ...status, status: { externalPowerVoltage: 655.36 } }));
  assert.throws(() => decodedEvent.parse({ ...status, status: { externalPowerVoltage: -1 } }));
});

test('UI preserves zero voltage and false flags and labels absent coordinates', () => {
  const log = decodeLog({ ...row, protocol_data: { trackingEnabled: false, charging: false } });
  const summary = summarizeLog(log);

  assert.equal(log.location, null);
  assert.match(summary, /External voltage 0\.00 V/);
  assert.match(summary, /Position not provided/);
  assert.match(summary, /GPS tracking flag OFF/);
  assert.match(summary, /Charging OFF/);
  assert.doesNotMatch(summary, /0\.000000, 0\.000000|km\/h|Mileage/);
});

test('UI shows coordinates, zero speed/heading, GPS fix and raw mileage without assuming its unit', () => {
  const log = decodeLog({
    ...row,
    location: { latitude: 23, longitude: 72, speedKph: 0, headingDegrees: 0 },
    status: { gpsValid: true },
    protocol_data: { mileageRaw: 0 },
  });
  const summary = summarizeLog(log);

  assert.match(summary, /23\.000000, 72\.000000/);
  assert.match(summary, /0 km\/h/);
  assert.match(summary, /Heading 0°/);
  assert.match(summary, /GPS fix valid/);
  assert.match(summary, /Mileage 0 \(raw; unit unspecified\)/);
  assert.doesNotMatch(summary, /Mileage 0 km/);
  assert.equal(
    summarizeLog(decodeLog({ ...row, protocol_data: undefined, status: null })),
    'Position not provided',
  );
});
