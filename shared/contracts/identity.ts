import { z } from 'zod';

export const activeIdentity = z.object({
  id: z.string().min(1),
  organization_id: z.string().min(1),
  role: z.enum(['admin', 'operator', 'viewer']),
});

export const socketIdentity = activeIdentity.extend({
  session_hash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type ActiveIdentity = z.infer<typeof activeIdentity>;

export type SocketIdentity = z.infer<typeof socketIdentity>;

export const ticketInput = z.object({ ticket: z.string().regex(/^[a-f0-9]{64}$/) });

export const authorizationInput = z.object({ sessionHash: z.string().regex(/^[a-f0-9]{64}$/) });

export const realtimeEvent = z
  .object({
    eventId: z.string().uuid(),
    organizationId: z.string().uuid(),
    deviceId: z.string().uuid(),
    logId: z.string().uuid(),
  })
  .strict();

export type RealtimeEvent = z.infer<typeof realtimeEvent>;
