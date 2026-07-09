import type {
  Campaign,
  CampaignDraftCreate,
  CampaignListItem,
  CampaignUpdate,
} from '@signal/contracts';
import { count, desc, eq, ne } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { campaigns, responses, targetRegistry } from '../db/schema.js';

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
