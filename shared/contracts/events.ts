import { z } from 'zod';

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
    if (e.validation.decodeStatus === 'DECODED' && e.validation.checksum === 'INVALID') {
      ctx.addIssue({ code: 'custom', message: 'Invalid checksum cannot be decoded' });
    }
  });

export type DecodedEvent = z.infer<typeof decodedEvent>;
