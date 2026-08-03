import { z } from 'zod';
import {
  askFrequencySchema,
  metricTypeSchema,
  onPositiveActionSchema,
  ratingTypeSchema,
  workflowStatusSchema,
} from '../primitives.js';

/**
 * Console workflow contracts (B2, was `campaigns`). A workflow listens for a named
 * `event_name` and, when eligible, presents a CSAT/CES ask. Mirrors the
 * `workflows` DB table with snake_case wire field names.
 *
 * - `event_name` (B2-D2): required to publish; free text (shape validated only —
 *   the event registry is B3). Immutable after the first response (semantic lock).
 * - `sampling_rate` (B2-D2): 0–1 probability the ask fires after the other gates.
 * - `min_session_age_days` (B2-D2, renamed from `min_tenure_days`).
 *
 * Timestamps accept either a Date (as Drizzle returns) or an ISO string (as
 * serialized JSON carries), so the read shape works for both.
 */
const timestampSchema = z.union([z.date(), z.iso.datetime()]);

const eventNameSchema = z.string().min(1).max(200);
const samplingRateSchema = z.number().min(0).max(1);

/** POST /workflows body. A draft is created empty. Minimal is `{}`. */
export const workflowDraftCreateSchema = z.object({});
export type WorkflowDraftCreate = z.infer<typeof workflowDraftCreateSchema>;

/**
 * PATCH /workflows/:id body. All builder fields are optional (partial), but
 * validated when present. `status`, `created_by` and timestamps are NOT accepted
 * here — those are controlled by lifecycle endpoints.
 */
export const workflowUpdateSchema = z.object({
  event_name: eventNameSchema.optional(),
  sampling_rate: samplingRateSchema.optional(),
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
  min_session_age_days: z.int().nonnegative().nullable().optional(),
});
export type WorkflowUpdate = z.infer<typeof workflowUpdateSchema>;

/**
 * Full persisted workflow shape returned to the console. Content fields that a
 * draft may leave blank are `.nullable()`.
 */
export const workflowSchema = z.object({
  id: z.uuid(),
  event_name: z.string().nullable(),
  sampling_rate: z.number(),
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
  min_session_age_days: z.int().nullable(),
  status: workflowStatusSchema,
  created_by: z.string(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Workflow = z.infer<typeof workflowSchema>;

/** Lighter list projection for GET /workflows. */
export const workflowListItemSchema = z.object({
  id: z.uuid(),
  event_name: z.string().nullable(),
  header_text: z.string().nullable(),
  status: workflowStatusSchema,
  updated_at: timestampSchema,
});
export type WorkflowListItem = z.infer<typeof workflowListItemSchema>;
