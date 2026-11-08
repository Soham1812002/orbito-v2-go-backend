import { z } from 'zod';

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

export type LogQuery = z.infer<typeof logQuery>;
