import { z } from 'zod';
import { triggerMechanismSchema } from '../primitives.js';

/**
 * Console target read contract (M2, Task 7). Mirrors the `target_registry` DB
 * table but uses snake_case wire field names (matching the SDK contracts'
 * style). `integration_status` matches the `integration_status` DB enum.
 */
export const integrationStatusSchema = z.enum([
  'not_sent',
  'sent_to_engineering',
  'confirmed_live',
]);
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

export const targetSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  screen_id: z.string(),
  trigger_mechanism: triggerMechanismSchema,
  integration_status: integrationStatusSchema,
});
export type Target = z.infer<typeof targetSchema>;
