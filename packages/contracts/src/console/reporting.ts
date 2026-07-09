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
