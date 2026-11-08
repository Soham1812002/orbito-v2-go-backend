import { z } from 'zod';

export const vehicleId = z.string().uuid();

export const vehicleSearch = z.object({
  q: z.string().max(100).default(''),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
