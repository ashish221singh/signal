import type { CampaignOverview } from '@signal/contracts';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { campaigns, responses, triggerLog } from '../db/schema.js';

/**
 * Campaign Overview reporting query (M2, Task 16). Returns the trigger/response
 * counts and the two derived ratios, or `null` if the campaign does not exist
 * (the route turns that into a 404).
 *
 * Binding decisions (M2-D15):
 * - `response_rate = responses / triggers`, but `null` when triggers === 0
 *   (never divide by zero — rendered "—" in the console).
 * - `positive_score = count(rating_value >= positive_threshold) / responses`,
 *   but `null` when responses === 0, and also `null` when the campaign has no
 *   `positive_threshold` yet (a draft can't score positivity).
 *
 * The positive count uses a filtered aggregate
 * (`count(*) filter (where rating_value >= $threshold)`) so triggers, responses
 * and the positive count all come back in a couple of small counting queries.
 */
export async function campaignOverview(
  db: Db,
  campaignId: string,
): Promise<CampaignOverview | null> {
  // Confirm the campaign exists and read its threshold (nullable for drafts).
  const [campaign] = await db
    .select({ positiveThreshold: campaigns.positiveThreshold })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!campaign) return null;

  const threshold = campaign.positiveThreshold;

  const [triggerRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(triggerLog)
    .where(eq(triggerLog.campaignId, campaignId));

  // One pass over responses: total count + positive count via a filtered
  // aggregate. When the threshold is null we don't attempt the filter (it can't
  // be computed), leaving positive_score null below.
  const [responseRow] = await db
    .select({
      total: sql<number>`count(*)::int`,
      positive:
        threshold === null
          ? sql<number>`0::int`
          : sql<number>`count(*) filter (where ${responses.ratingValue} >= ${threshold})::int`,
    })
    .from(responses)
    .where(eq(responses.campaignId, campaignId));

  const triggers = triggerRow?.count ?? 0;
  const total = responseRow?.total ?? 0;
  const positive = responseRow?.positive ?? 0;

  const response_rate = triggers === 0 ? null : total / triggers;
  const positive_score = total === 0 || threshold === null ? null : positive / total;

  return {
    campaign_id: campaignId,
    triggers,
    responses: total,
    response_rate,
    positive_score,
  };
}
