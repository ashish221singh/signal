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
