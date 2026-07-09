import { z } from 'zod';

/**
 * Console client read contract (M2, Task 7). Mirrors the `clients` DB table.
 * `status` matches the `client_status` DB enum.
 */
export const clientStatusSchema = z.enum(['active', 'inactive']);
export type ClientStatus = z.infer<typeof clientStatusSchema>;

export const clientSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: clientStatusSchema,
});
export type Client = z.infer<typeof clientSchema>;
