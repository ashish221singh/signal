import type {
  AttentionItem,
  CampaignHealth,
  CampaignOverview,
  ClientBreakdown,
  DashboardSummary,
  Reasons,
  ResponseFeedItem,
  Trend,
} from '@signal/contracts';
import { and, desc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
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
 * Cursor codec for the Responses feed (M4, Task 4). A cursor packs the last
 * item's `(responded_at, id)` tuple so the next page can resume with a strict
 * `<` tuple comparison — stable even when several responses share a timestamp.
 */
function encodeCursor(respondedAt: Date, id: string): string {
  return Buffer.from(`${respondedAt.toISOString()}|${id}`).toString('base64url');
}
function decodeCursor(c: string): { ts: Date; id: string } | null {
  try {
    const [ts, id] = Buffer.from(c, 'base64url').toString().split('|');
    if (!ts || !id) return null;
    return { ts: new Date(ts), id };
  } catch {
    return null;
  }
}

/**
 * Responses drill-down feed (M4, Task 4). Cursor-paginated, newest-first
 * (`responded_at desc, id desc`), optionally filtered by an inclusive
 * `min_rating`/`max_rating` band. Returns `null` if the campaign does not exist
 * (the route turns that into a 404, M4-D12).
 *
 * Pagination (M4-D4): we over-fetch `limit + 1` rows; if the extra row exists,
 * the last item of the page is encoded into `next_cursor`. The cursor resumes
 * via a tuple comparison `(responded_at, id) < (ts, id)`, so pages never
 * overlap even when timestamps collide. Timestamps are bound as ISO strings
 * cast to `::timestamptz` because postgres.js can't bind a raw `Date` inside a
 * `sql` fragment.
 */
export async function campaignResponses(
  db: Db,
  campaignId: string,
  opts: { minRating?: number; maxRating?: number; cursor?: string; limit: number },
): Promise<{ items: ResponseFeedItem[]; next_cursor: string | null } | null> {
  const [campaign] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!campaign) return null;

  const conds = [eq(responses.campaignId, campaignId)];
  if (opts.minRating !== undefined) conds.push(gte(responses.ratingValue, opts.minRating));
  if (opts.maxRating !== undefined) conds.push(lte(responses.ratingValue, opts.maxRating));

  const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (cur) {
    conds.push(
      sql`(${responses.respondedAt}, ${responses.id}) < (${cur.ts.toISOString()}::timestamptz, ${cur.id}::uuid)`,
    );
  }

  const rows = await db
    .select()
    .from(responses)
    .where(and(...conds))
    .orderBy(desc(responses.respondedAt), desc(responses.id))
    .limit(opts.limit + 1);

  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  const next = rows.length > opts.limit && last ? encodeCursor(last.respondedAt, last.id) : null;

  return {
    items: page.map((r) => ({
      id: r.id,
      rating_value: r.ratingValue,
      chip_selected: r.chipSelected,
      other_text: r.otherText,
      other_image_url: r.otherImageUrl,
      location: r.location,
      client_id: r.clientId,
      device_os: r.deviceOs,
      app_version: r.appVersion,
      shown_at: r.shownAt.toISOString(),
      responded_at: r.respondedAt.toISOString(),
    })),
    next_cursor: next,
  };
}

/**
 * 30-day positive-score trend reporting query (M4, Task 5). Returns one point
 * per UTC calendar day THAT HAS responses in the last 30 days ending at `now`
 * (days with no responses are simply absent), ordered by date ascending, or
 * `null` if the campaign does not exist (the route turns that into a 404,
 * M4-D12).
 *
 * Window: `[now - 30 days, now]`, bound as ISO strings cast to `::timestamptz`
 * because the postgres.js driver can't bind a raw `Date` inside a `sql`
 * fragment (same pattern as `dashboardSummary`). The rolling `now` is threaded
 * from the app clock so tests are deterministic.
 *
 * Per day (M4-D4/§10): `responses` = `count(*)`; `positive` = a filtered
 * aggregate `count(*) filter (where rating_value >= threshold)` (only when the
 * campaign has a threshold). Grouping is on `date_trunc('day', responded_at at
 * time zone 'UTC')` and the `date` string is emitted as the UTC calendar day —
 * both pinned to UTC explicitly so the bucket boundary never drifts with the
 * session timezone. `positive_score = threshold === null ? null : positive /
 * responses` (a grouped day always has ≥1 response, so it's never null for the
 * divide-by-zero reason).
 */
export async function campaignTrend(db: Db, campaignId: string, now: Date): Promise<Trend | null> {
  const [campaign] = await db
    .select({ positiveThreshold: campaigns.positiveThreshold })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!campaign) return null;

  const threshold = campaign.positiveThreshold;

  // postgres.js can't bind a raw JS `Date` inside a `sql` fragment, so bind the
  // window boundaries as ISO strings cast to timestamptz (like dashboardSummary).
  const windowStartIso = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = now.toISOString();
  const windowStart = sql`${windowStartIso}::timestamptz`;
  const windowEnd = sql`${nowIso}::timestamptz`;

  // Bucket by the UTC calendar day. `at time zone 'UTC'` pins the truncation to
  // UTC regardless of the session timezone; the same expression is formatted as
  // the YYYY-MM-DD date string so the point's date is always the UTC day.
  const day = sql`date_trunc('day', ${responses.respondedAt} at time zone 'UTC')`;

  const rows = await db
    .select({
      date: sql<string>`to_char(${day}, 'YYYY-MM-DD')`,
      responses: sql<number>`count(*)::int`,
      positive:
        threshold === null
          ? sql<number>`0::int`
          : sql<number>`count(*) filter (where ${responses.ratingValue} >= ${threshold})::int`,
    })
    .from(responses)
    .where(
      and(
        eq(responses.campaignId, campaignId),
        gte(responses.respondedAt, windowStart),
        lte(responses.respondedAt, windowEnd),
      ),
    )
    .groupBy(day)
    .orderBy(day);

  return {
    campaign_id: campaignId,
    points: rows.map((r) => ({
      date: r.date,
      responses: r.responses,
      positive_score: threshold === null ? null : r.positive / r.responses,
    })),
  };
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
