import { z } from 'zod';

export const traceContext = z.object({
  traceId: z.string().regex(/^(?!0{32}$)[a-f0-9]{32}$/),
  spanId: z.string().regex(/^(?!0{16}$)[a-f0-9]{16}$/),
});

export type TraceContext = z.infer<typeof traceContext>;
