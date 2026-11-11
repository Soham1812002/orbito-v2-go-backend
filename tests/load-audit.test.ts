import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../utils/stress/audit.js';

test('load audit deduplicates DB/spool overlap by event ID and detects missing confirmed packets', () => {
  const confirmed: [string, number][] = [
    ['device:hash', 2],
    ['other:second', 1],
  ];
  const event = { eventId: 'one', imei: 'device', hash: 'hash' };
  const complete = reconcile(confirmed, [
    event,
    event,
    { ...event, eventId: 'two' },
    { eventId: 'three', imei: 'other', hash: 'second' },
  ]);

  assert.equal(complete.uniqueDurableEvents, 3);
  assert.equal(complete.confirmedMissing, 0);
  assert.equal(reconcile(confirmed, [event, event]).confirmedMissing, 2);
  assert.equal(reconcile([['device:hash', 2]], [event], [['device:hash', 1]]).confirmedMissing, 0);
  assert.equal(reconcile([], [event, { ...event, hash: 'changed' }]).conflictingEventIds, 1);
});
