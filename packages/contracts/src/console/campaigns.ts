import { z } from 'zod';
import {
  askFrequencySchema,
  campaignStatusSchema,
  metricTypeSchema,
  onPositiveActionSchema,
  ratingTypeSchema,
} from '../primitives.js';

/**
 * Console campaign contracts (M2, Task 9). Mirrors the `campaigns` DB table but
 * uses snake_case wire field names (matching the other console/SDK contracts).
 * Enums are reused from primitives — notably `askFrequencySchema` is the
 * reconciled cooldown enum (after_7/30/60_days) and `campaignStatusSchema`
 * now includes `archived` to match the DB `campaign_status` enum. No
 * `daily_cap` field exists anywhere.
 *
 * Timestamps accept either a Date (as Drizzle returns) or an ISO string (as
 * serialized JSON carries), so the read shape works for both.
 */
const timestampSchema = z.union([z.date(), z.iso.datetime()]);

/**
 * POST /campaigns body. A draft is created empty (no client targeting in B1 —
 * clients were removed with the generic-SaaS pivot, B1-D6). Minimal is `{}`.
 */
export const campaignDraftCreateSchema = z.object({});
export type CampaignDraftCreate = z.infer<typeof campaignDraftCreateSchema>;

/**
 * PATCH /campaigns/:id body (Task 11). All builder fields are optional
 * (partial), but validated when present. `status`, `created_by` and timestamps
 * are NOT accepted here — those are controlled by lifecycle endpoints.
 */
export const campaignUpdateSchema = z.object({
  target_id: z.uuid().optional(),
  metric_type: metricTypeSchema.optional(),
  rating_type: ratingTypeSchema.optional(),
  rating_scale_max: z.int().positive().optional(),
  header_text: z.string().min(1).optional(),
  positive_threshold: z.int().positive().optional(),
  chips_on_negative: z.array(z.string()).optional(),
  other_requires_text: z.boolean().optional(),
  other_allows_image: z.boolean().optional(),
  on_positive_action: onPositiveActionSchema.optional(),
  ask_frequency: askFrequencySchema.optional(),
  min_tenure_days: z.int().nullable().optional(),
});
export type CampaignUpdate = z.infer<typeof campaignUpdateSchema>;

/**
 * Full persisted campaign shape returned to the console. Content fields that a
 * draft may leave blank are `.nullable()`.
 */
export const campaignSchema = z.object({
  id: z.uuid(),
  target_id: z.uuid().nullable(),
  metric_type: metricTypeSchema.nullable(),
  rating_type: ratingTypeSchema.nullable(),
  rating_scale_max: z.int().nullable(),
  header_text: z.string().nullable(),
  positive_threshold: z.int().nullable(),
  chips_on_negative: z.array(z.string()),
  other_requires_text: z.boolean(),
  other_allows_image: z.boolean(),
  on_positive_action: onPositiveActionSchema,
  ask_frequency: askFrequencySchema,
  min_tenure_days: z.int().nullable(),
  status: campaignStatusSchema,
  created_by: z.string(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Campaign = z.infer<typeof campaignSchema>;

/**
 * Lighter list projection for GET /campaigns. `screen_id` is the target's
 * screen id (nullable when the draft has no target yet).
 */
export const campaignListItemSchema = z.object({
  id: z.uuid(),
  header_text: z.string().nullable(),
  status: campaignStatusSchema,
  screen_id: z.string().nullable(),
  updated_at: timestampSchema,
});
export type CampaignListItem = z.infer<typeof campaignListItemSchema>;
