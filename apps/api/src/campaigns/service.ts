import type {
  Campaign,
  CampaignDraftCreate,
  CampaignListItem,
  CampaignUpdate,
} from '@signal/contracts';
import { and, count, desc, eq, ne, sql } from 'drizzle-orm';
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
 * The six columns + non-empty `client_ids` that the DB CHECK
 * (`campaigns_active_complete`) requires before a campaign may go `active`.
 * Mirrored in code (M2-D5) so publish can list the *missing* fields in a 422
 * rather than surfacing a raw CHECK violation. Wire (snake_case) names.
 */
export type MissingField =
  | 'target_id'
  | 'metric_type'
  | 'rating_type'
  | 'rating_scale_max'
  | 'header_text'
  | 'positive_threshold'
  | 'client_ids';

/** The active campaign a publish would collide with (M2-D8 / M1-D3). */
export interface OverlapConflict {
  id: string;
  header: string | null;
}

/**
 * Discriminated outcome of `publish` so the route can map to
 * 200 / 404 / 422 (incomplete) / 409 (overlap). Extends the `UpdateResult`
 * style with the two publish-specific failure reasons, each carrying the extra
 * payload the route surfaces alongside the standard error envelope.
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
 * Console-side campaign service (M2, Task 10). Distinct from the SDK-side
 * `campaigns/cache.ts`/`loader.ts` (which feed the eligibility hot path — not
 * touched here). Backs the guarded `/v1/console/campaigns` CRUD routes.
 *
 * The `clock` dependency is injected now so Task 11 (update) can stamp
 * `updatedAt` deterministically; for Task 10 the DB `defaultNow()` handles
 * `created_at`/`updated_at` on insert.
 */
export type CampaignRow = typeof campaigns.$inferSelect;

/** Map a Drizzle row (camelCase) to the snake_case `campaignSchema` wire shape. */
export function toCampaign(r: CampaignRow): Campaign {
  return {
    id: r.id,
    target_id: r.targetId,
    client_ids: r.clientIds,
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
  if (r.clientIds.length === 0) missing.push('client_ids');
  return missing;
}

export class CampaignService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /**
   * Insert a minimal draft row. `createdBy` is the authenticated PM (M2-D18);
   * `clientIds` come from the body (default `[]`); all content columns stay NULL
   * and `status` defaults to 'draft'. Timestamps use the DB `defaultNow()`.
   */
  async create(createdBy: string, body: CampaignDraftCreate): Promise<Campaign> {
    const [row] = await this.db
      .insert(campaigns)
      .values({
        createdBy,
        clientIds: body.client_ids ?? [],
      })
      .returning();
    if (!row) throw new Error('campaign insert returned no row');
    return toCampaign(row);
  }

  async getById(id: string): Promise<Campaign | null> {
    const [row] = await this.db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    return row ? toCampaign(row) : null;
  }

  /**
   * Partial update of a draft's builder fields (M2, Task 11).
   *
   * - Unknown id → `{ ok: false, reason: 'not_found' }`.
   * - If the patch touches ANY semantic field (M2-D9) AND the campaign already
   *   has ≥1 response, the change would redefine historical score math →
   *   `{ ok: false, reason: 'semantic_locked' }` (no write).
   * - Otherwise apply ONLY the provided keys (partial — unset columns untouched),
   *   always stamp `updatedAt = clock.now()`, and return the updated campaign.
   *
   * The body is expected already validated by `campaignUpdateSchema` at the route.
   */
  async update(id: string, patch: CampaignUpdate): Promise<UpdateResult> {
    const existing = await this.db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(eq(campaigns.id, id))
      .limit(1);
    if (existing.length === 0) return { ok: false, reason: 'not_found' };

    const touchesSemantic = SEMANTIC_FIELDS.some((f) => f in patch);
    if (touchesSemantic) {
      const [row] = await this.db
        .select({ n: count() })
        .from(responses)
        .where(eq(responses.campaignId, id));
      if ((row?.n ?? 0) > 0) return { ok: false, reason: 'semantic_locked' };
    }

    // Build the update set from ONLY the provided keys (partial update).
    const set: Partial<typeof campaigns.$inferInsert> = { updatedAt: this.clock.now() };
    if ('target_id' in patch) set.targetId = patch.target_id;
    if ('client_ids' in patch) set.clientIds = patch.client_ids;
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
      .where(eq(campaigns.id, id))
      .returning();
    if (!updated) return { ok: false, reason: 'not_found' };
    return { ok: true, campaign: toCampaign(updated) };
  }

  /**
   * Publish a draft (M2, Task 12): validate completeness in code, reject an
   * overlapping active campaign, then flip `status = 'active'`.
   *
   * - Unknown id → `{ ok: false, reason: 'not_found' }`.
   * - Missing any of the six required content columns or an empty `client_ids`
   *   (mirrors the `campaigns_active_complete` CHECK, M2-D5) →
   *   `{ ok: false, reason: 'incomplete', missing: [...] }` (wire field names).
   * - An existing ACTIVE campaign on the same `target_id` sharing ≥1 client
   *   (M2-D8, the other half of M1-D3) →
   *   `{ ok: false, reason: 'overlap', conflict: { id, header } }` (first match).
   * - Otherwise stamp `updatedAt` and set `status = 'active'`.
   *
   * NOTE (M2-D7): publish is NEVER gated on the target's `integration_status`.
   * A `not_sent` target still publishes fine — integration status is an
   * operational health signal, not a publish precondition.
   */
  async publish(id: string): Promise<PublishResult> {
    const [row] = await this.db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!row) return { ok: false, reason: 'not_found' };

    const missing = missingRequiredFields(row);
    if (missing.length > 0) return { ok: false, reason: 'incomplete', missing };

    // `targetId` is guaranteed non-null here (completeness passed above).
    const conflict = await this.findActiveOverlap(id, row.targetId as string, row.clientIds);
    if (conflict) return { ok: false, reason: 'overlap', conflict };

    const [updated] = await this.db
      .update(campaigns)
      .set({ status: 'active', updatedAt: this.clock.now() })
      .where(eq(campaigns.id, id))
      .returning();
    if (!updated) return { ok: false, reason: 'not_found' };
    return { ok: true, campaign: toCampaign(updated) };
  }

  /**
   * Pause an ACTIVE campaign → `paused` (M2, Task 13). Unknown id → `not_found`;
   * pausing a non-active (draft/paused/archived) campaign → `invalid_state`
   * (minimal guard, M2-D6). A paused campaign is absent from the SDK cache
   * (which loads only `status = 'active'`), so it stops being served on refresh.
   */
  async pause(id: string): Promise<TransitionResult> {
    const [row] = await this.db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status !== 'active') return { ok: false, reason: 'invalid_state' };

    const [updated] = await this.db
      .update(campaigns)
      .set({ status: 'paused', updatedAt: this.clock.now() })
      .where(eq(campaigns.id, id))
      .returning();
    if (!updated) return { ok: false, reason: 'not_found' };
    return { ok: true, campaign: toCampaign(updated) };
  }

  /**
   * Resume a PAUSED campaign → `active` (M2, Task 13). Unknown id → `not_found`;
   * resuming a non-paused campaign → `invalid_state`. Because an active campaign
   * on the same (target, client) may have appeared while this one was paused,
   * resume RE-RUNS the same overlap check publish uses (M2-D8) — a clash →
   * `overlap` (campaign stays paused). Reuses `findActiveOverlap` (Task 12).
   */
  async resume(id: string): Promise<ResumeResult> {
    const [row] = await this.db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status !== 'paused') return { ok: false, reason: 'invalid_state' };

    // A paused campaign is always complete (it was active before), so `targetId`
    // is non-null. Re-run the overlap check before reactivating.
    const conflict = await this.findActiveOverlap(id, row.targetId as string, row.clientIds);
    if (conflict) return { ok: false, reason: 'overlap', conflict };

    const [updated] = await this.db
      .update(campaigns)
      .set({ status: 'active', updatedAt: this.clock.now() })
      .where(eq(campaigns.id, id))
      .returning();
    if (!updated) return { ok: false, reason: 'not_found' };
    return { ok: true, campaign: toCampaign(updated) };
  }

  /**
   * Archive a campaign → `archived` from any non-archived state (M2, Task 13,
   * M2-D6 "delete = archive"). Unknown id → `not_found`; already archived →
   * `invalid_state` (idempotent no-op guard). Archived campaigns are excluded
   * from the default list (Task 10) and from the SDK cache (which loads only
   * `active`), so no extra exclusion work is needed beyond setting the status.
   */
  async archive(id: string): Promise<TransitionResult> {
    const [row] = await this.db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status === 'archived') return { ok: false, reason: 'invalid_state' };

    const [updated] = await this.db
      .update(campaigns)
      .set({ status: 'archived', updatedAt: this.clock.now() })
      .where(eq(campaigns.id, id))
      .returning();
    if (!updated) return { ok: false, reason: 'not_found' };
    return { ok: true, campaign: toCampaign(updated) };
  }

  /**
   * Hard delete a campaign row (M2, Task 13). Named `remove` to avoid the JS
   * `delete` keyword. Per M2-D6 a physical delete is permitted ONLY for a
   * `draft` with ZERO `trigger_log` and ZERO `responses` rows — FK-referenced
   * history must never be destroyed. Anything else (has history, or not a draft
   * even with zero history) → `has_history` (route surfaces `archive instead`).
   * Unknown id → `not_found`.
   */
  async remove(id: string): Promise<RemoveResult> {
    const [row] = await this.db
      .select({ status: campaigns.status })
      .from(campaigns)
      .where(eq(campaigns.id, id))
      .limit(1);
    if (!row) return { ok: false, reason: 'not_found' };

    // Only drafts are hard-deletable (M2-D6). The draft status is the real
    // safety gate — any campaign that ever went active is archived, not deleted.
    if (row.status !== 'draft') {
      return { ok: false, reason: 'has_history' };
    }

    // Belt-and-suspenders: count EVERY FK child that references campaigns.id
    // (all ON DELETE no action) so a hard delete can never orphan/destroy
    // history even if a draft somehow acquired child rows.
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

    await this.db.delete(campaigns).where(eq(campaigns.id, id));
    return { ok: true };
  }

  /**
   * Find an ACTIVE campaign on `targetId` whose `client_ids` intersects
   * `clientIds`, excluding `excludeId` (the campaign being published/resumed).
   * Returns the first match's `{ id, header }` or null. Task 13's resume reuses
   * this. Uses the Postgres jsonb `?|` operator (client_ids ?| text[]) — the
   * param is bound, never string-concatenated. `[]` short-circuits (no overlap).
   */
  private async findActiveOverlap(
    excludeId: string,
    targetId: string,
    clientIds: string[],
  ): Promise<OverlapConflict | null> {
    if (clientIds.length === 0) return null;
    const [conflict] = await this.db
      .select({ id: campaigns.id, header: campaigns.headerText })
      .from(campaigns)
      .where(
        and(
          eq(campaigns.status, 'active'),
          eq(campaigns.targetId, targetId),
          ne(campaigns.id, excludeId),
          sql`${campaigns.clientIds} ?| ${sql.param(clientIds)}::text[]`,
        ),
      )
      .orderBy(campaigns.createdAt)
      .limit(1);
    return conflict ?? null;
  }

  /**
   * List campaigns ordered by `updatedAt desc`. Excludes archived unless
   * `includeArchived` (M2-D6). LEFT JOINs `target_registry` for `screen_id`
   * (nullable when a draft has no target). `client_count` = size of clientIds.
   */
  async list({ includeArchived }: { includeArchived: boolean }): Promise<CampaignListItem[]> {
    const rows = await this.db
      .select({
        id: campaigns.id,
        header_text: campaigns.headerText,
        status: campaigns.status,
        screen_id: targetRegistry.screenId,
        client_ids: campaigns.clientIds,
        updated_at: campaigns.updatedAt,
      })
      .from(campaigns)
      .leftJoin(targetRegistry, eq(campaigns.targetId, targetRegistry.id))
      .where(includeArchived ? undefined : ne(campaigns.status, 'archived'))
      .orderBy(desc(campaigns.updatedAt));

    return rows.map((r) => ({
      id: r.id,
      header_text: r.header_text,
      status: r.status,
      screen_id: r.screen_id,
      client_count: r.client_ids.length,
      updated_at: r.updated_at,
    }));
  }
}
