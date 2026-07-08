import { z } from 'zod';

export const SIGNAL_API_VERSION = '0.1.0';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
