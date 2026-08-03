import type {
  Campaign,
  CampaignDraftCreate,
  CampaignListItem,
  CampaignUpdate,
} from '@signal/contracts';
import { and, count, desc, eq, ne } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import {
  campaigns,
  responses,
  suppressionState,
  targetRegistry,
  triggerLog,
} from '../db/schema.js';

/**
 * Semantic fields (M2-D9): they define the score math. Once a campaign has ≥1
 * response, changing them would silently redefine historical scores, so they are
 * immutable from that point on (route surfaces `semantic_locked`). All other
 * (operational) fields stay editable regardless.
 */
export const SEMANTIC_FIELDS = [
  'metric_type',
  'rating_type',
  'rating_scale_max',
  'positive_threshold',
] as const satisfies readonly (keyof CampaignUpdate)[];

/** Discriminated outcome so the route can map to 200 / 404 / 422. */
export type UpdateResult =
  | { ok: true; campaign: Campaign }
  | { ok: false; reason: 'not_found' | 'semantic_locked' };

/**
 * The columns the DB CHECK (`campaigns_active_complete`) requires before a
 * campaign may go `active`. Mirrored in code (M2-D5) so publish can list the
 * *missing* fields in a 422 rather than surfacing a raw CHECK violation.
 * Wire (snake_case) names. B1-D6 dropped `client_ids` from the CHECK.
 */
export type MissingField =
  | 'target_id'
  | 'metric_type'
  | 'rating_type'
  | 'rating_scale_max'
  | 'header_text'
  | 'positive_threshold';

/** The active campaign a publish would collide with (M2-D8 / one active per target). */
export interface OverlapConflict {
  id: string;
  header: string | null;
}

/**
 * Discriminated outcome of `publish` so the route can map to
 * 200 / 404 / 422 (incomplete) / 409 (overlap).
 */
export type PublishResult =
  | { ok: true; campaign: Campaign }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'incomplete'; missing: MissingField[] }
  | { ok: false; reason: 'overlap'; conflict: OverlapConflict };

/**
 * Outcome of `pause`/`archive` (state transitions with a simple guard). `archive`
 * never returns `invalid_state` (any non-archived state may archive), but reuses
 * the same union so the route can map `not_found` uniformly.
 */
export type TransitionResult =
  | { ok: true; campaign: Campaign }
  | { ok: false; reason: 'not_found' | 'invalid_state' };

/**
 * Outcome of `resume`: like a transition but it re-runs the active-overlap check
 * (M2-D8) before flipping back to active, so it can also fail with `overlap`.
 */
export type ResumeResult =
  | { ok: true; campaign: Campaign }
  | { ok: false; reason: 'not_found' | 'invalid_state' }
  | { ok: false; reason: 'overlap'; conflict: OverlapConflict };

/**
 * Outcome of `remove` (hard delete). Only a draft with zero trigger/response
 * history is physically deletable (M2-D6); anything else → `has_history`.
 */
export type RemoveResult = { ok: true } | { ok: false; reason: 'not_found' | 'has_history' };

/**
 * Console-side campaign service (M2, Task 10). Every read and write is scoped by
 * `account_id` (B1-D8): a campaign is only visible/mutable to its owning account,
 * and new rows are stamped with the account. Distinct from the SDK-side
 * `campaigns/cache.ts`/`loader.ts` (the eligibility hot path — not touched here).
 */
export type CampaignRow = typeof campaigns.$inferSelect;

/** Map a Drizzle row (camelCase) to the snake_case `campaignSchema` wire shape. */
export function toCampaign(r: CampaignRow): Campaign {
  return {
    id: r.id,
    target_id: r.targetId,
    metric_type: r.metricType,
    rating_type: r.ratingType,
    rating_scale_max: r.ratingScaleMax,
    header_text: r.headerText,
    positive_threshold: r.positiveThreshold,
    chips_on_negative: r.chipsOnNegative,
    other_requires_text: r.otherRequiresText,
    other_allows_image: r.otherAllowsImage,
    on_positive_action: r.onPositiveAction,
    ask_frequency: r.askFrequency,
    min_tenure_days: r.minTenureDays,
    status: r.status,
    created_by: r.createdBy,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

/**
 * Collect the wire (snake_case) names of the completeness fields a row is
 * missing, mirroring the `campaigns_active_complete` DB CHECK (M2-D5). Empty
 * array ⇒ the row is publishable.
 */
export function missingRequiredFields(r: CampaignRow): MissingField[] {
  const missing: MissingField[] = [];
  if (r.targetId === null) missing.push('target_id');
  if (r.metricType === null) missing.push('metric_type');
  if (r.ratingType === null) missing.push('rating_type');
  if (r.ratingScaleMax === null) missing.push('rating_scale_max');
  if (r.headerText === null) missing.push('header_text');
  if (r.positiveThreshold === null) missing.push('positive_threshold');
  return missing;
}

export class CampaignService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /**
   * Insert a minimal draft row owned by `accountId` and `createdBy` (M2-D18).
   * All content columns stay NULL; `status` defaults to 'draft'. Timestamps use
   * the DB `defaultNow()`. `_body` is accepted for signature stability (drafts
   * carry no fields in B1 after clients were removed).
   */
  async create(
    accountId: string,
    createdBy: string,
    _body: CampaignDraftCreate,
  ): Promise<Campaign> {
    const [row] = await this.db.insert(campaigns).values({ accountId, createdBy }).returning();
    if (!row) throw new Error('campaign insert returned no row');
    return toCampaign(row);
  }

  async getById(accountId: string, id: string): Promise<Campaign | null> {
    const [row] = await this.db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)))
      .limit(1);
    return row ? toCampaign(row) : null;
  }

  /**
   * Partial update of a draft's builder fields (M2, Task 11), scoped to
   * `accountId`. Unknown id (or another account's id) → `not_found`. If the
   * patch touches ANY semantic field (M2-D9) AND the campaign already has ≥1
   * response → `semantic_locked` (no write). Otherwise apply only the provided
   * keys and stamp `updatedAt`.
   */
  async update(accountId: string, id: string, patch: CampaignUpdate): Promise<UpdateResult> {
    const existing = await this.db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)))
      .limit(1);
    if (existing.length === 0) return { ok: false, reason: 'not_found' };

    const touchesSemantic = SEMANTIC_FIELDS.some((f) => f in patch);
    if (touchesSemantic) {
      const [row] = await this.db
        .select({ n: count() })
        .from(responses)
        .where(and(eq(responses.campaignId, id), eq(responses.accountId, accountId)));
      if ((row?.n ?? 0) > 0) return { ok: false, reason: 'semantic_locked' };
    }

    const set: Partial<typeof campaigns.$inferInsert> = { updatedAt: this.clock.now() };
    if ('target_id' in patch) set.targetId = patch.target_id;
    if ('metric_type' in patch) set.metricType = patch.metric_type;
    if ('rating_type' in patch) set.ratingType = patch.rating_type;
    if ('rating_scale_max' in patch) set.ratingScaleMax = patch.rating_scale_max;
    if ('header_text' in patch) set.headerText = patch.header_text;
    if ('positive_threshold' in patch) set.positiveThreshold = patch.positive_threshold;
    if ('chips_on_negative' in patch) set.chipsOnNegative = patch.chips_on_negative;
    if ('other_requires_text' in patch) set.otherRequiresText = patch.other_requires_text;
    if ('other_allows_image' in patch) set.otherAllowsImage = patch.other_allows_image;
    if ('on_positive_action' in patch) set.onPositiveAction = patch.on_positive_action;
    if ('ask_frequency' in patch) set.askFrequency = patch.ask_frequency;
    if ('min_tenure_days' in patch) set.minTenureDays = patch.min_tenure_days;

    const [updated] = await this.db
      .update(campaigns)
      .set(set)
      .where(and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)))
      .returning();
    if (!updated) return { ok: false, reason: 'not_found' };
    return { ok: true, campaign: toCampaign(updated) };
  }

  /**
   * Publish a draft (M2, Task 12), scoped to `accountId`: validate completeness
   * in code, reject an overlapping active campaign on the same target within the
   * account, then flip `status = 'active'`.
   *
   * NOTE (M2-D7): publish is NEVER gated on the target's `integration_status`.
   */
  async publish(accountId: string, id: string): Promise<PublishResult> {
    const [row] = await this.db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)))
      .limit(1);
    if (!row) return { ok: false, reason: 'not_found' };

    const missing = missingRequiredFields(row);
    if (missing.length > 0) return { ok: false, reason: 'incomplete', missing };

    // `targetId` is guaranteed non-null here (completeness passed above).
    const conflict = await this.findActiveOverlap(accountId, id, row.targetId as string);
    if (conflict) return { ok: false, reason: 'overlap', conflict };

    const [updated] = await this.db
      .update(campaigns)
      .set({ status: 'active', updatedAt: this.clock.now() })
      .where(and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)))
      .returning();
    if (!updated) return { ok: false, reason: 'not_found' };
    return { ok: true, campaign: toCampaign(updated) };
  }

  /** Pause an ACTIVE campaign → `paused` (M2, Task 13), scoped to `accountId`. */
  async pause(accountId: string, id: string): Promise<TransitionResult> {
    const [row] = await this.db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)))
      .limit(1);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status !== 'active') return { ok: false, reason: 'invalid_state' };

    const [updated] = await this.db
      .update(campaigns)
      .set({ status: 'paused', updatedAt: this.clock.now() })
      .where(and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)))
      .returning();
    if (!updated) return { ok: false, reason: 'not_found' };
    return { ok: true, campaign: toCampaign(updated) };
  }

  /**
   * Resume a PAUSED campaign → `active` (M2, Task 13), scoped to `accountId`.
   * Re-runs the same active-overlap check publish uses (M2-D8).
   */
  async resume(accountId: string, id: string): Promise<ResumeResult> {
    const [row] = await this.db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)))
      .limit(1);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status !== 'paused') return { ok: false, reason: 'invalid_state' };

    const conflict = await this.findActiveOverlap(accountId, id, row.targetId as string);
    if (conflict) return { ok: false, reason: 'overlap', conflict };

    const [updated] = await this.db
      .update(campaigns)
      .set({ status: 'active', updatedAt: this.clock.now() })
      .where(and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)))
      .returning();
    if (!updated) return { ok: false, reason: 'not_found' };
    return { ok: true, campaign: toCampaign(updated) };
  }

  /** Archive a campaign → `archived` from any non-archived state (M2, Task 13). */
  async archive(accountId: string, id: string): Promise<TransitionResult> {
    const [row] = await this.db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)))
      .limit(1);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status === 'archived') return { ok: false, reason: 'invalid_state' };

    const [updated] = await this.db
      .update(campaigns)
      .set({ status: 'archived', updatedAt: this.clock.now() })
      .where(and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)))
      .returning();
    if (!updated) return { ok: false, reason: 'not_found' };
    return { ok: true, campaign: toCampaign(updated) };
  }

  /**
   * Hard delete a campaign row (M2, Task 13), scoped to `accountId`. Only a
   * `draft` with ZERO trigger/response/suppression history is deletable (M2-D6).
   */
  async remove(accountId: string, id: string): Promise<RemoveResult> {
    const [row] = await this.db
      .select({ status: campaigns.status })
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)))
      .limit(1);
    if (!row) return { ok: false, reason: 'not_found' };

    if (row.status !== 'draft') {
      return { ok: false, reason: 'has_history' };
    }

    const [trig] = await this.db
      .select({ n: count() })
      .from(triggerLog)
      .where(eq(triggerLog.campaignId, id));
    const [resp] = await this.db
      .select({ n: count() })
      .from(responses)
      .where(eq(responses.campaignId, id));
    const [supp] = await this.db
      .select({ n: count() })
      .from(suppressionState)
      .where(eq(suppressionState.campaignId, id));
    if ((trig?.n ?? 0) > 0 || (resp?.n ?? 0) > 0 || (supp?.n ?? 0) > 0) {
      return { ok: false, reason: 'has_history' };
    }

    await this.db
      .delete(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)));
    return { ok: true };
  }

  /**
   * Find an ACTIVE campaign in the account on `targetId`, excluding `excludeId`.
   * One active campaign per (account, target) is the B1 rule (client targeting
   * was removed with the generic-SaaS pivot). Returns the first match or null.
   */
  private async findActiveOverlap(
    accountId: string,
    excludeId: string,
    targetId: string,
  ): Promise<OverlapConflict | null> {
    const [conflict] = await this.db
      .select({ id: campaigns.id, header: campaigns.headerText })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.accountId, accountId),
          eq(campaigns.status, 'active'),
          eq(campaigns.targetId, targetId),
          ne(campaigns.id, excludeId),
        ),
      )
      .orderBy(campaigns.createdAt)
      .limit(1);
    return conflict ?? null;
  }

  /**
   * List campaigns for the account ordered by `updatedAt desc`. Excludes archived
   * unless `includeArchived` (M2-D6). LEFT JOINs `target_registry` for `screen_id`.
   */
  async list(
    accountId: string,
    { includeArchived }: { includeArchived: boolean },
  ): Promise<CampaignListItem[]> {
    const statusCond = includeArchived ? undefined : ne(campaigns.status, 'archived');
    const rows = await this.db
      .select({
        id: campaigns.id,
        header_text: campaigns.headerText,
        status: campaigns.status,
        screen_id: targetRegistry.screenId,
        updated_at: campaigns.updatedAt,
      })
      .from(campaigns)
      .leftJoin(targetRegistry, eq(campaigns.targetId, targetRegistry.id))
      .where(
        statusCond
          ? and(eq(campaigns.accountId, accountId), statusCond)
          : eq(campaigns.accountId, accountId),
      )
      .orderBy(desc(campaigns.updatedAt));

    return rows.map((r) => ({
      id: r.id,
      header_text: r.header_text,
      status: r.status,
      screen_id: r.screen_id,
      updated_at: r.updated_at,
    }));
  }
}
