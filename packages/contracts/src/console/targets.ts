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

/**
 * Create contract (M2, Task 14). The PM supplies only a non-empty display name
 * and the trigger mechanism; `screen_id` is slugified server-side (never
 * client-supplied) and `integration_status` defaults to `not_sent`.
 */
export const targetCreateSchema = z.object({
  name: z.string().min(1),
  trigger_mechanism: triggerMechanismSchema,
});
export type TargetCreate = z.infer<typeof targetCreateSchema>;
