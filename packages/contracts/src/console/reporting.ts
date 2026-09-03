import { z } from 'zod';

/**
 * Console reporting contracts (M2, Task 16). Overview only — the dashboard
 * summary is Task 17, and Reasons/Clients/Responses tabs are M4 (M2-D10).
 *
 * All numbers are snake_case wire fields matching the other console contracts.
 * Rates/scores are floats, and are `null` when they cannot be computed without
 * dividing by zero (M2-D15): `response_rate` is null when there are zero
 * triggers, `positive_score` is null when there are zero responses (or the
 * campaign has no `positive_threshold` yet).
 */

/**
 * GET /v1/console/campaigns/:id/overview response shape.
 * - `triggers` = count of trigger_log rows for the campaign
 * - `responses` = count of responses rows for the campaign
 * - `response_rate` = responses / triggers (null if triggers === 0)
 * - `positive_score` = (#responses with rating_value >= positive_threshold) /
 *   responses (null if responses === 0 or threshold is unset)
 */
export const campaignOverviewSchema = z.object({
  campaign_id: z.uuid(),
  triggers: z.int(),
  responses: z.int(),
  response_rate: z.number().nullable(),
  positive_score: z.number().nullable(),
});
export type CampaignOverview = z.infer<typeof campaignOverviewSchema>;

/**
 * GET /v1/console/dashboard response shape (M2, Task 17). The console landing
 * summary — the WHOLE reporting scope alongside the Overview (M2-D10); the
 * Reasons/Clients/Responses tabs are M4 and are NOT built here.
 *
 * All metrics use a rolling 30-day window ending at "now" (triggers by their
 * `shown_at`, responses by their `responded_at`). Rates/scores stay null-safe
 * (M2-D15): a rate is `null` when there is nothing to divide by.
 */

/** The reason a campaign surfaces in the attention strip (M2-D11). */
export const attentionReasonSchema = z.enum(['target_not_live', 'low_response_rate', 'low_score']);
export type AttentionReason = z.infer<typeof attentionReasonSchema>;

/** One attention-strip entry — a campaign can appear once per triggered rule. */
export const attentionItemSchema = z.object({
  campaign_id: z.uuid(),
  header: z.string().nullable(),
  reason: attentionReasonSchema,
});
export type AttentionItem = z.infer<typeof attentionItemSchema>;

/** One row of the campaign-health list (active + paused campaigns only). */
export const campaignHealthSchema = z.object({
  campaign_id: z.uuid(),
  header: z.string().nullable(),
  status: z.enum(['draft', 'active', 'paused', 'archived']),
  integration_status: z.enum(['not_sent', 'sent_to_engineering', 'confirmed_live']).nullable(),
  triggers_30d: z.int(),
  responses_30d: z.int(),
  response_rate: z.number().nullable(),
  positive_score: z.number().nullable(),
});
export type CampaignHealth = z.infer<typeof campaignHealthSchema>;

export const dashboardSummarySchema = z.object({
  kpis: z.object({
    active_campaigns: z.int(),
    total_triggers_30d: z.int(),
    avg_positive_score: z.number().nullable(),
  }),
  attention: z.array(attentionItemSchema),
  campaigns: z.array(campaignHealthSchema),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

/**
 * GET /v1/console/campaigns/:id/reasons response shape (M4, Reasons tab).
 * Aggregates chip selections for a campaign. `share` is `count /
 * total_chip_responses`, and is `0` when `total_chip_responses` is 0.
 */
export const reasonsSchema = z.object({
  campaign_id: z.uuid(),
  total_chip_responses: z.int(),
  chips: z.array(
    z.object({
      chip: z.string(),
      count: z.int(),
      share: z.number(), // count / total_chip_responses; 0 when total is 0
    }),
  ),
});
export type Reasons = z.infer<typeof reasonsSchema>;

/**
 * One row of the Responses feed (M4, Responses tab). `location` is null when
 * the response carried no geo; `chip_selected`, `other_text` and
 * `other_image_url` are null when the corresponding input was not provided.
 */
export const responseFeedItemSchema = z.object({
  id: z.uuid(),
  rating_value: z.int(),
  chip_selected: z.string().nullable(),
  other_text: z.string().nullable(),
  other_image_url: z.string().nullable(),
  // End-user identity (F5) — the client's own id, plus optional name/email traits.
  user_id: z.string(),
  user_name: z.string().nullable(),
  user_email: z.string().nullable(),
  location: z
    .object({
      lat: z.number(),
      lng: z.number(),
      state: z.string().optional(),
      country: z.string().optional(),
    })
    .nullable(),
  device_os: z.string(),
  app_version: z.string(),
  shown_at: z.string(),
  responded_at: z.string(),
});
export type ResponseFeedItem = z.infer<typeof responseFeedItemSchema>;

/** GET /v1/console/campaigns/:id/responses response shape (cursor-paginated). */
export const responseFeedSchema = z.object({
  items: z.array(responseFeedItemSchema),
  next_cursor: z.string().nullable(),
});
export type ResponseFeed = z.infer<typeof responseFeedSchema>;

/**
 * Query params for the Responses feed. Values arrive as query strings so they
 * are coerced; `limit` defaults to 50 and is capped at 200.
 */
export const responseFeedQuerySchema = z.object({
  min_rating: z.coerce.number().int().min(1).max(5).optional(),
  max_rating: z.coerce.number().int().min(1).max(5).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ResponseFeedQuery = z.infer<typeof responseFeedQuerySchema>;

/**
 * GET /v1/console/campaigns/:id/trend response shape (M4, 30-day trend).
 * One point per UTC day; `positive_score` is null when a day had zero
 * responses (or the campaign has no positive_threshold).
 */
export const trendSchema = z.object({
  campaign_id: z.uuid(),
  points: z.array(
    z.object({
      date: z.string(), // YYYY-MM-DD (UTC)
      responses: z.int(),
      positive_score: z.number().nullable(),
    }),
  ),
});
export type Trend = z.infer<typeof trendSchema>;

/**
 * GET /v1/console/events/overview response shape (B4-D5). An account-wide roll-up
 * of triggers/responses grouped by `event_name` — the event-model counterpart to
 * the per-workflow overview. `response_rate` is null when an event had zero
 * triggers; `positive_score` is null when it had zero responses (or no workflow
 * with a `positive_threshold` covered the responses). All fields null-safe.
 */
export const eventOverviewRowSchema = z.object({
  event_name: z.string(),
  triggers: z.int(),
  responses: z.int(),
  response_rate: z.number().nullable(),
  positive_score: z.number().nullable(),
});
export type EventOverviewRow = z.infer<typeof eventOverviewRowSchema>;

export const eventsOverviewSchema = z.object({
  events: z.array(eventOverviewRowSchema),
});
export type EventsOverview = z.infer<typeof eventsOverviewSchema>;
