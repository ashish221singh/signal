import type {
  AttentionItem,
  CampaignHealth,
  CampaignOverview,
  DashboardSummary,
  Reasons,
  ResponseFeedItem,
  Trend,
} from '@signal/contracts';
import { and, desc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { campaigns, responses, targetRegistry, triggerLog } from '../db/schema.js';

/**
 * Attention-strip thresholds (M2-D11). Hard-coded named constants — NOT config.
 */
export const RESPONSE_RATE_ATTENTION_THRESHOLD = 0.15;
export const POSITIVE_SCORE_ATTENTION_THRESHOLD = 0.6;

/** Rolling window length for all dashboard metrics. */
const WINDOW_DAYS = 30;

/**
 * Campaign Overview reporting query (M2, Task 16), scoped to `accountId` (B1-D8).
 * Returns the trigger/response counts and the two derived ratios, or `null` if
 * the campaign does not exist within the account (route → 404).
 */
export async function campaignOverview(
  db: Db,
  accountId: string,
  campaignId: string,
): Promise<CampaignOverview | null> {
  const [campaign] = await db
    .select({ positiveThreshold: campaigns.positiveThreshold })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.accountId, accountId)))
    .limit(1);
  if (!campaign) return null;

  const threshold = campaign.positiveThreshold;

  const [triggerRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(triggerLog)
    .where(eq(triggerLog.campaignId, campaignId));

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
 * Campaign Reasons reporting query (M4, Task 2), scoped to `accountId`.
 */
export async function campaignReasons(
  db: Db,
  accountId: string,
  campaignId: string,
): Promise<Reasons | null> {
  const [campaign] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.accountId, accountId)));
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
 * Cursor codec for the Responses feed (M4, Task 4).
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
 * Responses drill-down feed (M4, Task 4), scoped to `accountId`. Cursor-paginated,
 * newest-first, optionally filtered by an inclusive score band. Returns `null` if
 * the campaign does not exist within the account (route → 404).
 */
export async function campaignResponses(
  db: Db,
  accountId: string,
  campaignId: string,
  opts: { minRating?: number; maxRating?: number; cursor?: string; limit: number },
): Promise<{ items: ResponseFeedItem[]; next_cursor: string | null } | null> {
  const [campaign] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.accountId, accountId)));
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
      device_os: r.deviceOs,
      app_version: r.appVersion,
      shown_at: r.shownAt.toISOString(),
      responded_at: r.respondedAt.toISOString(),
    })),
    next_cursor: next,
  };
}

/**
 * 30-day positive-score trend reporting query (M4, Task 5), scoped to `accountId`.
 */
export async function campaignTrend(
  db: Db,
  accountId: string,
  campaignId: string,
  now: Date,
): Promise<Trend | null> {
  const [campaign] = await db
    .select({ positiveThreshold: campaigns.positiveThreshold })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.accountId, accountId)))
    .limit(1);
  if (!campaign) return null;

  const threshold = campaign.positiveThreshold;

  const windowStartIso = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = now.toISOString();
  const windowStart = sql`${windowStartIso}::timestamptz`;
  const windowEnd = sql`${nowIso}::timestamptz`;

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
 * Dashboard summary reporting query (M2, Task 17), scoped to `accountId` (B1-D8) —
 * KPIs, the attention strip, and the campaign-health list, all restricted to the
 * account's own campaigns.
 */
export async function dashboardSummary(
  db: Db,
  accountId: string,
  now: Date,
): Promise<DashboardSummary> {
  const windowStartIso = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const windowStart = sql`${windowStartIso}::timestamptz`;

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
    .where(
      and(eq(campaigns.accountId, accountId), sql`${campaigns.status} in ('active', 'paused')`),
    );

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

    if (row.status === 'active' && positive_score !== null) {
      activePositiveScores.push(positive_score);
    }
  }

  // total_triggers_30d: in-window triggers across THIS ACCOUNT's campaigns.
  const [triggerRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(triggerLog)
    .where(and(eq(triggerLog.accountId, accountId), sql`${triggerLog.shownAt} >= ${windowStart}`));

  // active_campaigns: count of status='active' campaigns in this account.
  const [activeRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(campaigns)
    .where(and(eq(campaigns.accountId, accountId), eq(campaigns.status, 'active')));

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
