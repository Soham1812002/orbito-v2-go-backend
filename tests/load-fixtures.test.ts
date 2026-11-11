import test from 'node:test';
import assert from 'node:assert/strict';
import { frame, packet } from '../utils/stress/protocol.js';

test('load encoder agrees with captured heartbeat and independent PDF ACK vectors', () => {
  assert.equal(
    frame(0x13, 0x013d, Buffer.from('0406040002', 'hex')).toString('hex'),
    '78780a130406040002013d98e50d0a',
  );
  assert.equal(frame(1, 5, Buffer.alloc(0)).toString('hex'), '7878050100059ff80d0a');
  const status = packet(0x94, 2, new Date());

  assert.equal(status.expected.location, null);
  assert.equal(status.expected.status.externalPowerVoltage, 11.83);
  assert.equal(status.bytes.subarray(0, 2).toString('hex'), '7979');
});
