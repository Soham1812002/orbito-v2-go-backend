import { z } from 'zod';

export const profiles = [
  {
    id: 'markon-v1-diagnostic',
    protocol: 'MARKON_AIS140',
    manufacturer: 'Markon',
    model: 'WeTrack140',
    port: 5001,
    diagnostic: true,
  },
  {
    id: 'concox-v29-standard',
    protocol: 'CONCOX',
    manufacturer: 'Concox',
    model: 'Standard 13/22',
    port: 5002,
    diagnostic: false,
  },
  {
    id: 'concox-v29-eg02',
    protocol: 'CONCOX',
    manufacturer: 'Concox',
    model: 'EG02/EG03',
    port: 5002,
    diagnostic: false,
  },
] as const;
export const vehicleInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    registrationNumber: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .refine((v) => /[a-z0-9]/i.test(v), 'Must contain letters or numbers'),
    imei: z.string().regex(/^\d{15}$/),
    profileId: z.enum(['markon-v1-diagnostic', 'concox-v29-standard', 'concox-v29-eg02']),
    model: z.string().trim().min(1).max(80),
    firmware: z.string().trim().max(80).default(''),
    vehicleType: z.enum(['car', 'van', 'truck', 'bus', 'other']).default('other'),
    notes: z.string().trim().max(1000).default(''),
    expectedInterval: z.number().int().min(5).max(86400).default(60),
    enabled: z.boolean().default(true),
  })
  .strict();
export const vehiclePatch = vehicleInput
  .pick({ name: true, registrationNumber: true, vehicleType: true, notes: true, enabled: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0);
export const decodedEvent = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string().uuid(),
    deviceIdentifier: z.string().regex(/^\d{15}$/),
    protocol: z.enum(['MARKON_AIS140', 'CONCOX']),
    profile: z.string().min(1).max(80),
    packetType: z.string().max(40),
    eventType: z.enum(['LOGIN', 'HEARTBEAT', 'LOCATION', 'DEVICE_EVENT', 'DIAGNOSTIC']),
    deviceTimestamp: z.string().datetime().nullable(),
    receivedAt: z.string().datetime(),
    historical: z.boolean(),
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        speedKph: z.number().min(0).max(1000).nullable(),
        headingDegrees: z.number().min(0).lt(360).nullable(),
      })
      .nullable(),
    status: z
      .object({
        ignition: z.boolean().nullable().optional(),
        gpsValid: z.boolean().nullable().optional(),
        batteryLevel: z.number().int().min(0).max(6).nullable().optional(),
        batteryPercent: z.number().min(0).max(100).nullable().optional(),
        batteryVoltage: z.number().min(0).max(100).nullable().optional(),
        gsmLevel: z.number().int().min(0).max(31).nullable().optional(),
        externalPowerConnected: z.boolean().nullable().optional(),
      })
      .strict(),
    validation: z.object({
      decodeStatus: z.enum(['DECODED', 'UNSUPPORTED', 'INVALID_CHECKSUM', 'MALFORMED']),
      checksum: z.enum(['VALID', 'INVALID', 'NOT_PRESENT', 'UNVERIFIED']),
      warnings: z.array(z.string().max(200)).max(20),
    }),
    source: z.object({
      sequence: z.string().max(40).nullable(),
      rawSha256: z.string().regex(/^[a-f0-9]{64}$/),
      sessionId: z.string().uuid(),
      raw: z.string().max(16384).optional(),
    }),
    protocolData: z.record(z.unknown()),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.validation.decodeStatus === 'DECODED' && e.validation.checksum === 'INVALID')
      ctx.addIssue({ code: 'custom', message: 'Invalid checksum cannot be decoded' });
  });
export type DecodedEvent = z.infer<typeof decodedEvent>;
export type VehicleInput = z.infer<typeof vehicleInput>;
export const logQuery = z.object({
  deviceId: z.string().uuid().optional(),
  protocol: z.enum(['CONCOX', 'MARKON_AIS140']).optional(),
  packetType: z.string().max(40).optional(),
  decodeStatus: z.enum(['DECODED', 'UNSUPPORTED', 'INVALID_CHECKSUM', 'MALFORMED']).optional(),
  q: z.string().max(100).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const registrationKey = (value: string) => value.toUpperCase().replace(/[\s-]/g, '');
