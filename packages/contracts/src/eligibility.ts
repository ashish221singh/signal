import { z } from 'zod';
import { metricTypeSchema, onPositiveActionSchema, ratingTypeSchema } from './primitives.js';

/**
 * SDK eligibility request (B2-D5). The generic ingest contract: a named
 * `event_name` is the trigger, `context` is optional free-text metadata (never a
 * targeting key, e.g. a screen name for debugging), and `session_age_days` feeds
 * the optional min-session-age gate. `screen_id`/`client_id` are gone.
 */
export const eligibilityQuerySchema = z.object({
  event_name: z.string().min(1),
  user_id: z.string().min(1),
  context: z.string().min(1).optional(),
  session_age_days: z.coerce.number().int().nonnegative().optional(),
});
export type EligibilityQuery = z.infer<typeof eligibilityQuerySchema>;

/**
 * SDK eligibility config response (B2-D5: shape unchanged). `campaign_id` is kept
 * as the wire field name for backward compatibility with the response config
 * shape — it carries the resolved workflow's id.
 */
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
