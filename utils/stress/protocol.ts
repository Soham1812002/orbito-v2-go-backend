// Synthetic Concox frames use only layouts evidenced by V5_UPDATED and captured heartbeats.
import { createHash } from 'node:crypto';

export function crc(data: Buffer): number {
  let value = 0xffff;

  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? (value >>> 1) ^ 0x8408 : value >>> 1;
    }
  }

  return ~value & 0xffff;
}

export function frame(type: number, serial: number, body: Buffer, extended = false): Buffer {
  const length = body.length + 5;
  const header = extended
    ? Buffer.from([0x79, 0x79, length >>> 8, length & 255, type])
    : Buffer.from([0x78, 0x78, length, type]);
  const sequence = Buffer.alloc(2);

  sequence.writeUInt16BE(serial);
  const content = Buffer.concat([header, body, sequence]);
  const check = Buffer.alloc(2);

  check.writeUInt16BE(crc(content.subarray(2)));

  return Buffer.concat([content, check, Buffer.from([13, 10])]);
}

export function login(imei: string): Buffer {
  return frame(
    1,
    1,
    Buffer.concat([Buffer.from(`0${imei}`, 'hex'), Buffer.from('80660002', 'hex')]),
  );
}

export const heartbeat = (serial: number) => frame(0x13, serial, Buffer.from('0406040002', 'hex'));

function timestamp(date: Date) {
  return Buffer.from([
    date.getUTCFullYear() - 2000,
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ]);
}

export interface ExpectedPacket {
  type: string;
  rawHash: string;
  eventType: string;
  location: {
    latitude: number;
    longitude: number;
    speedKph: number;
    headingDegrees: number;
  } | null;
  status: Record<string, number | boolean>;
}

export function packet(
  type: number,
  serial: number,
  date: Date,
): { bytes: Buffer; expected: ExpectedPacket } {
  let body: Buffer;
  let location: ExpectedPacket['location'] = null;
  let status: ExpectedPacket['status'];
  let eventType: string;

  switch (type) {
    case 0x13:
      body = Buffer.from('0406040002', 'hex');
      eventType = 'HEARTBEAT';
      status = { ignition: false, batteryLevel: 6, gsmLevel: 4 };
      break;
    case 0x94:
      body = Buffer.from('00049f', 'hex');
      eventType = 'STATUS';
      status = { externalPowerVoltage: 11.83 };
      break;
    case 0x22:
      // PDF p.10 location body; use current UTC, current upload, and explicit valid fix/course.
      body = Buffer.from('0f0c1d023305c9027ac8180c46586000140001cc00287d001f71000001', 'hex');
      timestamp(date).copy(body);
      body[28] = 0;
      eventType = 'LOCATION';
      status = { ignition: false, gpsValid: true };
      location = {
        latitude: 41601048 / 1800000,
        longitude: 205936736 / 1800000,
        speedKph: 0,
        headingDegrees: 0,
      };
      break;
    case 0x26:
      // PDF p.17 alarm body with current UTC and valid north/east fix, zero course.
      body = Buffer.from('12030c063816c3026c10540c38c9700144030901cc002866000eee0c06040302', 'hex');
      timestamp(date).copy(body);
      body.writeUInt16BE(0x1400, 16);
      eventType = 'DEVICE_EVENT';
      status = { ignition: false, gpsValid: true, batteryLevel: 6, gsmLevel: 4 };
      location = {
        latitude: 40636500 / 1800000,
        longitude: 205048176 / 1800000,
        speedKph: 1,
        headingDegrees: 0,
      };
      break;
    default:
      throw new Error('Unsupported load fixture');
  }

  const bytes = frame(type, serial, body, type === 0x94);

  return {
    bytes,
    expected: {
      type: `0x${type.toString(16).toUpperCase()}`,
      rawHash: createHash('sha256').update(bytes).digest('hex'),
      eventType,
      location,
      status,
    },
  };
}
