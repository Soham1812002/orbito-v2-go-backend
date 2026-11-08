import { z } from 'zod';
import { vehicleInput } from '../../../../../shared/contracts/fleet.js';

export const assignmentInput = z
  .object({
    deviceId: z.string().uuid().optional(),
    device: vehicleInput
      .pick({ imei: true, profileId: true, model: true, firmware: true, expectedInterval: true })
      .optional(),
    effectiveAt: z.string().datetime(),
  })
  .strict()
  .refine((v) => Boolean(v.deviceId) !== Boolean(v.device), 'Choose an existing or a new tracker');

export type AssignmentInput = z.infer<typeof assignmentInput>;
