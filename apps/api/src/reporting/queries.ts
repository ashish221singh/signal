import type {
  AttentionItem,
  CampaignHealth,
  CampaignOverview,
  DashboardSummary,
  EventOverviewRow,
  Reasons,
  ResponseFeedItem,
  Trend,
} from '@signal/contracts';
import { and, desc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { responses, triggerLog, workflows } from '../db/schema.js';

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
    .select({ positiveThreshold: workflows.positiveThreshold })
    .from(workflows)
    .where(and(eq(workflows.id, campaignId), eq(workflows.accountId, accountId)))
    .limit(1);
  if (!campaign) return null;

  const threshold = campaign.positiveThreshold;

  const [triggerRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(triggerLog)
    .where(eq(triggerLog.workflowId, campaignId));

  const [responseRow] = await db
    .select({
      total: sql<number>`count(*)::int`,
      positive:
        threshold === null
          ? sql<number>`0::int`
          : sql<number>`count(*) filter (where ${responses.ratingValue} >= ${threshold})::int`,
    })
    .from(responses)
    .where(eq(responses.workflowId, campaignId));

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
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.id, campaignId), eq(workflows.accountId, accountId)));
  if (!campaign) return null;

  const rows = await db
    .select({ chip: responses.chipSelected, count: sql<number>`count(*)::int` })
    .from(responses)
    .where(and(eq(responses.workflowId, campaignId), isNotNull(responses.chipSelected)))
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
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.id, campaignId), eq(workflows.accountId, accountId)));
  if (!campaign) return null;

  const conds = [eq(responses.workflowId, campaignId)];
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
      // End-user identity (F5): the client's own id + optional name/email traits.
      user_id: r.userId,
      user_name: r.userName,
      user_email: r.userEmail,
      location: r.location,
      device_os: r.deviceOs,
      app_version: r.appVersion,
      session_age_days: r.sessionAgeDays,
      context: r.context,
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
    .select({ positiveThreshold: workflows.positiveThreshold })
    .from(workflows)
    .where(and(eq(workflows.id, campaignId), eq(workflows.accountId, accountId)))
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
        eq(responses.workflowId, campaignId),
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
 * Events overview reporting query (B4-D5), scoped to `accountId`. Rolls
 * triggers/responses up per `event_name` across the whole account — the event
 * model's counterpart to the per-workflow overview. `positive` counts responses
 * whose `rating_value` meets the covering workflow's `positive_threshold` (joined
 * per response), so an event served by multiple workflows aggregates correctly.
 * All ratios are null-safe; the list is ordered by triggers desc then event name.
 */
export async function eventsOverview(
  db: Db,
  accountId: string,
  opts: { since?: Date } = {},
): Promise<EventOverviewRow[]> {
  // Optional rolling window (F3 dashboard period filter 7/30/90). When `since` is
  // omitted the roll-up is all-time — the pre-F3 behavior, so existing callers and
  // tests are unchanged.
  const since = opts.since;

  // Per-event trigger counts (trigger_log carries account_id + event_name).
  const triggerWhere = since
    ? and(eq(triggerLog.accountId, accountId), gte(triggerLog.shownAt, since))
    : eq(triggerLog.accountId, accountId);
  const triggerRows = await db
    .select({ eventName: triggerLog.eventName, count: sql<number>`count(*)::int` })
    .from(triggerLog)
    .where(triggerWhere)
    .groupBy(triggerLog.eventName);

  // Per-event response + positive counts. Join each response to its workflow for
  // the positive_threshold; a null threshold contributes 0 positives.
  const responseWhere = since
    ? and(eq(responses.accountId, accountId), gte(responses.respondedAt, since))
    : eq(responses.accountId, accountId);
  const responseRows = await db
    .select({
      eventName: responses.eventName,
      total: sql<number>`count(*)::int`,
      uniqueUsers: sql<number>`count(distinct ${responses.userId})::int`,
      positive: sql<number>`count(*) filter (
        where ${workflows.positiveThreshold} is not null
          and ${responses.ratingValue} >= ${workflows.positiveThreshold}
      )::int`,
      withThreshold: sql<number>`count(*) filter (
        where ${workflows.positiveThreshold} is not null
      )::int`,
    })
    .from(responses)
    .innerJoin(workflows, eq(responses.workflowId, workflows.id))
    .where(responseWhere)
    .groupBy(responses.eventName);

  const triggerByEvent = new Map(triggerRows.map((r) => [r.eventName, r.count]));
  const responseByEvent = new Map(
    responseRows.map((r) => [
      r.eventName,
      {
        total: r.total,
        uniqueUsers: r.uniqueUsers,
        positive: r.positive,
        withThreshold: r.withThreshold,
      },
    ]),
  );

  const eventNames = new Set<string>([...triggerByEvent.keys(), ...responseByEvent.keys()]);

  const rows: EventOverviewRow[] = [];
  for (const eventName of eventNames) {
    const triggers = triggerByEvent.get(eventName) ?? 0;
    const resp = responseByEvent.get(eventName) ?? {
      total: 0,
      uniqueUsers: 0,
      positive: 0,
      withThreshold: 0,
    };
    const response_rate = triggers === 0 ? null : resp.total / triggers;
    // positive_score is over responses covered by a workflow with a threshold; if
    // no responses had a threshold, it can't be computed (null).
    const positive_score = resp.withThreshold === 0 ? null : resp.positive / resp.withThreshold;
    rows.push({
      event_name: eventName,
      triggers,
      responses: resp.total,
      unique_users: resp.uniqueUsers,
      response_rate,
      positive_score,
    });
  }

  rows.sort((a, b) => b.triggers - a.triggers || a.event_name.localeCompare(b.event_name));
  return rows;
}

/**
 * Distinct end-users who responded in the window (F5). Not the sum of per-event
 * uniques — a user can respond to multiple events — so it's a single account-wide
 * `count(distinct user_id)` over the same response window as `eventsOverview`.
 */
export async function distinctUsers(
  db: Db,
  accountId: string,
  opts: { since?: Date } = {},
): Promise<number> {
  const where = opts.since
    ? and(eq(responses.accountId, accountId), gte(responses.respondedAt, opts.since))
    : eq(responses.accountId, accountId);
  const [row] = await db
    .select({ count: sql<number>`count(distinct ${responses.userId})::int` })
    .from(responses)
    .where(where);
  return row?.count ?? 0;
}

/**
 * Whether an `event_name` is configured in the account (a workflow references it).
 * Gates the per-event drill-downs → 404 for an unknown event (F3).
 */
async function eventExists(db: Db, accountId: string, eventName: string): Promise<boolean> {
  const [row] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.accountId, accountId), eq(workflows.eventName, eventName)))
    .limit(1);
  return Boolean(row);
}

/**
 * Per-EVENT reasons roll-up (F3 drill-down) — ranked non-null chip selections with
 * shares, aggregated across every response for `event_name` in the account (an event
 * may be served by more than one workflow). Null if the event isn't configured.
 */
export async function eventReasons(
  db: Db,
  accountId: string,
  eventName: string,
): Promise<Reasons | null> {
  if (!(await eventExists(db, accountId, eventName))) return null;

  const rows = await db
    .select({ chip: responses.chipSelected, count: sql<number>`count(*)::int` })
    .from(responses)
    .where(
      and(
        eq(responses.accountId, accountId),
        eq(responses.eventName, eventName),
        isNotNull(responses.chipSelected),
      ),
    )
    .groupBy(responses.chipSelected)
    .orderBy(desc(sql`count(*)`));

  const total = rows.reduce((n, r) => n + r.count, 0);
  return {
    campaign_id: eventName,
    total_chip_responses: total,
    chips: rows.map((r) => ({
      chip: r.chip as string,
      count: r.count,
      share: total === 0 ? 0 : r.count / total,
    })),
  };
}

/**
 * Per-EVENT responses feed (F3 drill-down) — cursor-paginated, newest-first, across
 * all responses for `event_name` in the account, optionally filtered by an inclusive
 * score band. Null if the event isn't configured.
 */
export async function eventResponses(
  db: Db,
  accountId: string,
  eventName: string,
  opts: { minRating?: number; maxRating?: number; cursor?: string; limit: number },
): Promise<{ items: ResponseFeedItem[]; next_cursor: string | null } | null> {
  if (!(await eventExists(db, accountId, eventName))) return null;

  const conds = [eq(responses.accountId, accountId), eq(responses.eventName, eventName)];
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
      // End-user identity (F5): the client's own id + optional name/email traits.
      user_id: r.userId,
      user_name: r.userName,
      user_email: r.userEmail,
      location: r.location,
      device_os: r.deviceOs,
      app_version: r.appVersion,
      session_age_days: r.sessionAgeDays,
      context: r.context,
      shown_at: r.shownAt.toISOString(),
      responded_at: r.respondedAt.toISOString(),
    })),
    next_cursor: next,
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

  // Correlated-subquery references to the OUTER workflows row must be FULLY
  // qualified: in a select context Drizzle renders `${workflows.id}` as a bare
  // `"id"`, which inside the subquery would bind to the inner table's own `id`
  // column instead of correlating. `"workflows"."id"` / `.positive_threshold`
  // force the correlation.
  const wfId = sql`"workflows"."id"`;
  const wfThreshold = sql`"workflows"."positive_threshold"`;

  const triggers30d = sql<number>`(
    select count(*)::int from ${triggerLog} tl
    where tl.workflow_id = ${wfId} and tl.shown_at >= ${windowStart}
  )`;
  const responses30d = sql<number>`(
    select count(*)::int from ${responses} r
    where r.workflow_id = ${wfId} and r.responded_at >= ${windowStart}
  )`;
  const positive30d = sql<number>`(
    select count(*)::int from ${responses} r
    where r.workflow_id = ${wfId} and r.responded_at >= ${windowStart}
      and ${wfThreshold} is not null
      and r.rating_value >= ${wfThreshold}
  )`;

  const rows = await db
    .select({
      campaignId: workflows.id,
      header: workflows.headerText,
      status: workflows.status,
      hasThreshold: sql<boolean>`${workflows.positiveThreshold} is not null`,
      triggers: triggers30d,
      responses: responses30d,
      positive: positive30d,
    })
    .from(workflows)
    .where(
      and(eq(workflows.accountId, accountId), sql`${workflows.status} in ('active', 'paused')`),
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
      // B2-D1: the target/integration axis is gone; there is no integration
      // status to report on a workflow, so it is always null (and the
      // `target_not_live` attention rule no longer fires).
      integration_status: null,
      triggers_30d: triggers,
      responses_30d: responsesCount,
      response_rate,
      positive_score,
    });

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
    .from(workflows)
    .where(and(eq(workflows.accountId, accountId), eq(workflows.status, 'active')));

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
