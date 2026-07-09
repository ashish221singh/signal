import type { Campaign, CampaignDraftCreate, CampaignListItem } from '@signal/contracts';
import { desc, eq, ne } from 'drizzle-orm';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { campaigns, targetRegistry } from '../db/schema.js';

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
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: used by Task 11 (update).
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
