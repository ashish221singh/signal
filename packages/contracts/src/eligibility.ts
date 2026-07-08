import { z } from 'zod';
import { metricTypeSchema, onPositiveActionSchema, ratingTypeSchema } from './primitives.js';

export const eligibilityQuerySchema = z.object({
  screen_id: z.string().min(1),
  user_id: z.string().min(1),
  client_id: z.string().min(1),
  rep_tenure_days: z.coerce.number().int().nonnegative().optional(),
});
export type EligibilityQuery = z.infer<typeof eligibilityQuerySchema>;

export const eligibilityConfigSchema = z.object({
  trigger_id: z.uuid(),
  campaign_id: z.uuid(),
  metric_type: metricTypeSchema,
  header: z.string().min(1),
  rating_type: ratingTypeSchema,
  rating_scale_max: z.number().int(),
  positive_threshold: z.number().int(),
  chips_on_negative: z.array(z.string()),
  other_requires_text: z.boolean(),
  other_allows_image: z.boolean(),
  on_positive_action: onPositiveActionSchema,
  skip_enabled: z.boolean(),
});
export type EligibilityConfig = z.infer<typeof eligibilityConfigSchema>;
