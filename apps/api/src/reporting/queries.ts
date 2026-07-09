import type {
  AttentionItem,
  CampaignHealth,
  CampaignOverview,
  ClientBreakdown,
  DashboardSummary,
  Reasons,
} from '@signal/contracts';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { campaigns, responses, targetRegistry, triggerLog } from '../db/schema.js';

/**
 * Attention-strip thresholds (M2-D11). These are hard-coded named constants —
 * NOT config. A campaign surfaces in the dashboard attention list when its
 * 30-day response rate drops below `RESPONSE_RATE_ATTENTION_THRESHOLD` or its
 * 30-day positive score drops below `POSITIVE_SCORE_ATTENTION_THRESHOLD` (each
 * only when the metric is computable, i.e. non-null — no data is NOT attention).
 */
export const RESPONSE_RATE_ATTENTION_THRESHOLD = 0.15;
export const POSITIVE_SCORE_ATTENTION_THRESHOLD = 0.6;

/** Rolling window length for all dashboard metrics. */
const WINDOW_DAYS = 30;

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

/**
 * Campaign Reasons reporting query (M4, Task 2). Ranks the non-null
 * `chip_selected` selections for a campaign, most-selected first, or `null`
 * if the campaign does not exist (the route turns that into a 404).
 *
 * Binding decision (M4-D2): `total_chip_responses` counts responses whose
 * `chip_selected` is non-null; each chip's `share = count / total`, and `0`
 * when the total is 0 (never divide by zero).
 */
export async function campaignReasons(db: Db, campaignId: string): Promise<Reasons | null> {
  const [campaign] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!campaign) return null;

  const rows = await db
    .select({ chip: responses.chipSelected, count: sql<number>`count(*)::int` })
    .from(responses)
    .where(and(eq(responses.campaignId, campaignId), isNotNull(responses.chipSelected)))
    .groupBy(responses.chipSelected)
    .orderBy(desc(sql`count(*)`));

  const total = rows.reduce((n, r) => n + r.count, 0);
  return {
    campaign_id: campaignId,
    total_chip_responses: total,
    chips: rows.map((r) => ({
      chip: r.chip as string,
      count: r.count,
      share: total === 0 ? 0 : r.count / total,
    })),
  };
}

/**
 * Per-client campaign breakdown reporting query (M4, Task 3, Clients tab).
 * Returns one row per `client_id` in the campaign's `client_ids`, or `null` if
 * the campaign does not exist (the route turns that into a 404, M4-D12).
 *
 * Each client's triggers/responses/positive are computed with the SAME math as
 * `campaignOverview`, just scoped to that `client_id` (M4-D3):
 *  - `triggers` = trigger_log rows for the campaign+client.
 *  - `responses` total + `positive` = a filtered aggregate over responses for
 *    the campaign+client (positive only when the campaign has a threshold).
 *
 * Null-safety mirrors Overview (M4-D5):
 *  - `response_rate = responses / triggers`, but `null` when triggers === 0
 *    (a client with triggers but no responses stays 0, not null).
 *  - `positive_score = positive / responses`, but `null` when responses === 0
 *    or the campaign has no `positive_threshold`.
 *
 * A per-client loop of small counting queries is fine at this scale (it mirrors
 * how `campaignOverview` counts). The `client_ids` order is preserved.
 */
export async function campaignClientBreakdown(
  db: Db,
  campaignId: string,
): Promise<ClientBreakdown | null> {
  const [campaign] = await db
    .select({
      clientIds: campaigns.clientIds,
      positiveThreshold: campaigns.positiveThreshold,
    })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!campaign) return null;

  const threshold = campaign.positiveThreshold;
  const clients: ClientBreakdown['clients'] = [];

  for (const clientId of campaign.clientIds) {
    const [triggerRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(triggerLog)
      .where(and(eq(triggerLog.campaignId, campaignId), eq(triggerLog.clientId, clientId)));

    const [responseRow] = await db
      .select({
        total: sql<number>`count(*)::int`,
        positive:
          threshold === null
            ? sql<number>`0::int`
            : sql<number>`count(*) filter (where ${responses.ratingValue} >= ${threshold})::int`,
      })
      .from(responses)
      .where(and(eq(responses.campaignId, campaignId), eq(responses.clientId, clientId)));

    const triggers = triggerRow?.count ?? 0;
    const total = responseRow?.total ?? 0;
    const positive = responseRow?.positive ?? 0;

    clients.push({
      client_id: clientId,
      triggers,
      responses: total,
      response_rate: triggers === 0 ? null : total / triggers,
      positive_score: total === 0 || threshold === null ? null : positive / total,
    });
  }

  return { campaign_id: campaignId, clients };
}

/**
 * Dashboard summary reporting query (M2, Task 17) — KPIs, the attention strip,
 * and the campaign-health list. This is the WHOLE dashboard reporting scope
 * (M2-D10); the M4 tabs are out of scope.
 *
 * Window (M2-D15): all metrics use a rolling 30-day window ending at `now`
 * (threaded from the app clock so tests are deterministic). Triggers are
 * windowed by `shown_at`, responses by `responded_at`.
 *
 * Health list: one row per campaign whose status is `active` OR `paused`
 * (draft + archived excluded). Each row joins `target_registry` for the
 * target's `integration_status` (null when the campaign has no target). The
 * 30-day metrics are computed with correlated sub-selects so a campaign with
 * zero triggers still yields a row (rates stay null-safe).
 *
 * Attention (M2-D11): three constant-threshold rules, emitted as one entry per
 * triggered rule (a campaign can appear multiple times):
 *  - `target_not_live`: ACTIVE campaigns whose target isn't `confirmed_live`
 *    (not_sent, sent_to_engineering, or no target). Active-only.
 *  - `low_response_rate`: response_rate non-null AND < 0.15 (health-list set).
 *  - `low_score`: positive_score non-null AND < 0.60 (health-list set).
 *
 * KPIs:
 *  - `active_campaigns`: count of status='active' campaigns.
 *  - `total_triggers_30d`: in-window trigger_log rows across ALL campaigns.
 *  - `avg_positive_score`: simple (unweighted) mean of the per-active-campaign
 *    positive scores over those active campaigns with a computable score; null
 *    if none.
 */
export async function dashboardSummary(db: Db, now: Date): Promise<DashboardSummary> {
  // The postgres.js driver can't bind a raw JS `Date` inside a `sql` fragment,
  // so we bind the boundary as an ISO string cast to timestamptz.
  const windowStartIso = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const windowStart = sql`${windowStartIso}::timestamptz`;

  // Per-campaign 30-day metrics for the health-list set (active + paused).
  // Correlated sub-selects keep the row even when a campaign has no triggers,
  // and the LEFT JOIN to target_registry yields a null integration_status when
  // the campaign has no target.
  const triggers30d = sql<number>`(
    select count(*)::int from ${triggerLog} tl
    where tl.campaign_id = ${campaigns.id} and tl.shown_at >= ${windowStart}
  )`;
  const responses30d = sql<number>`(
    select count(*)::int from ${responses} r
    where r.campaign_id = ${campaigns.id} and r.responded_at >= ${windowStart}
  )`;
  const positive30d = sql<number>`(
    select count(*)::int from ${responses} r
    where r.campaign_id = ${campaigns.id} and r.responded_at >= ${windowStart}
      and ${campaigns.positiveThreshold} is not null
      and r.rating_value >= ${campaigns.positiveThreshold}
  )`;

  const rows = await db
    .select({
      campaignId: campaigns.id,
      header: campaigns.headerText,
      status: campaigns.status,
      integrationStatus: targetRegistry.integrationStatus,
      hasThreshold: sql<boolean>`${campaigns.positiveThreshold} is not null`,
      triggers: triggers30d,
      responses: responses30d,
      positive: positive30d,
    })
    .from(campaigns)
    .leftJoin(targetRegistry, eq(campaigns.targetId, targetRegistry.id))
    .where(sql`${campaigns.status} in ('active', 'paused')`);

  const campaignHealth: CampaignHealth[] = [];
  const attention: AttentionItem[] = [];
  const activePositiveScores: number[] = [];

  for (const row of rows) {
    const triggers = row.triggers ?? 0;
    const responsesCount = row.responses ?? 0;
    const positive = row.positive ?? 0;

    const response_rate = triggers === 0 ? null : responsesCount / triggers;
    const positive_score =
      responsesCount === 0 || !row.hasThreshold ? null : positive / responsesCount;

    campaignHealth.push({
      campaign_id: row.campaignId,
      header: row.header,
      status: row.status,
      integration_status: row.integrationStatus,
      triggers_30d: triggers,
      responses_30d: responsesCount,
      response_rate,
      positive_score,
    });

    // target_not_live: active campaigns whose target isn't confirmed_live.
    if (row.status === 'active' && row.integrationStatus !== 'confirmed_live') {
      attention.push({
        campaign_id: row.campaignId,
        header: row.header,
        reason: 'target_not_live',
      });
    }
    if (response_rate !== null && response_rate < RESPONSE_RATE_ATTENTION_THRESHOLD) {
      attention.push({
        campaign_id: row.campaignId,
        header: row.header,
        reason: 'low_response_rate',
      });
    }
    if (positive_score !== null && positive_score < POSITIVE_SCORE_ATTENTION_THRESHOLD) {
      attention.push({
        campaign_id: row.campaignId,
        header: row.header,
        reason: 'low_score',
      });
    }

    // The headline KPI intentionally averages ACTIVE campaigns only (paused ones
    // are still shown in the health list, but shouldn't move the "live" number).
    if (row.status === 'active' && positive_score !== null) {
      activePositiveScores.push(positive_score);
    }
  }

  // total_triggers_30d: in-window triggers across ALL campaigns (not just the
  // health-list set) — one aggregate over trigger_log.
  const [triggerRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(triggerLog)
    .where(sql`${triggerLog.shownAt} >= ${windowStart}`);

  // active_campaigns: count of status='active' campaigns.
  const [activeRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(campaigns)
    .where(eq(campaigns.status, 'active'));

  const avg_positive_score =
    activePositiveScores.length === 0
      ? null
      : activePositiveScores.reduce((sum, v) => sum + v, 0) / activePositiveScores.length;

  return {
    kpis: {
      active_campaigns: activeRow?.count ?? 0,
      total_triggers_30d: triggerRow?.count ?? 0,
      avg_positive_score,
    },
    attention,
    campaigns: campaignHealth,
  };
}
