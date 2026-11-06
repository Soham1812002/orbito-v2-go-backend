import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  vehicleInput,
  decodedEvent,
  registrationKey,
  type DecodedEvent,
} from '../packages/contracts/src/index.js';
import { fingerprint } from '../apps/backend-api/src/modules/ingestion.js';
import { hashPassword, verifyPassword } from '../apps/backend-api/src/modules/auth.js';
import { event } from './fixtures.js';
test('IMEI stays a 15-digit string and plate comparisons normalize separators', () => {
  const valid = {
    name: 'Van',
    registrationNumber: 'gj 01-ab 1234',
    imei: '012345678901234',
    model: 'GT800',
    profileId: 'concox-v29-standard',
  };
  assert.equal(vehicleInput.parse(valid).imei, '012345678901234');
  assert.equal(registrationKey(valid.registrationNumber), 'GJ01AB1234');
  assert.throws(() => vehicleInput.parse({ ...valid, imei: 123456789012345 }));
  assert.throws(() => vehicleInput.parse({ ...valid, organizationId: randomUUID() }));
});
test('unavailable values remain null; bad coordinates/checksum combinations rejected', () => {
  const e = event();
  e.location = null;
  assert.equal(decodedEvent.parse(e).location, null);
  const invalid = event();
  invalid.location!.latitude = 91;
  assert.throws(() => decodedEvent.parse(invalid));
  const bad = event();
  bad.validation.checksum = 'INVALID';
  assert.throws(() => decodedEvent.parse(bad));
});
test('HTTP retry and device retransmission identities are independent', () => {
  const e = event();
  const retransmitted = { ...e, eventId: randomUUID() };
  assert.equal(fingerprint(e), fingerprint(retransmitted));
  const heartbeat = { ...e, eventType: 'HEARTBEAT' as const, deviceTimestamp: null };
  assert.notEqual(fingerprint(heartbeat), fingerprint({ ...heartbeat, eventId: randomUUID() }));
});
test('password hashing is salted and rejects a wrong password', async () => {
  const a = await hashPassword('correct-password');
  const b = await hashPassword('correct-password');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('correct-password', a), true);
  assert.equal(await verifyPassword('incorrect', a), false);
});
