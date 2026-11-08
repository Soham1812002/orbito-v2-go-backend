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

export type VehicleInput = z.infer<typeof vehicleInput>;

export const registrationKey = (value: string) => value.toUpperCase().replace(/[\s-]/g, '');

export type VehiclePatch = z.infer<typeof vehiclePatch>;
