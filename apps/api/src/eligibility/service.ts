import type { EligibilityConfig } from '@signal/contracts';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { CampaignCache } from '../campaigns/cache.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { suppressionState, triggerLog } from '../db/schema.js';
import { claimShow } from './claim.js';
import { cooldownEndsAt } from './cooldown.js';
import { decide } from './decide.js';

export interface EligibilityQueryInput {
  screenId: string;
  userId: string;
  clientId: string;
  repTenureDays?: number;
}

export class EligibilityService {
  constructor(
    private readonly db: Db,
    private readonly cache: CampaignCache,
    private readonly clock: Clock,
    private readonly opts: { noCooldownDebounceSeconds: number },
  ) {}

  async check(input: EligibilityQueryInput): Promise<EligibilityConfig | null> {
    const campaign = this.cache.match(input.screenId, input.clientId);
    if (!campaign) return null;

    const now = this.clock.now();

    const [suppression] = await this.db
      .select()
      .from(suppressionState)
      .where(
        and(
          eq(suppressionState.userId, input.userId),
          eq(suppressionState.campaignId, campaign.id),
        ),
      );

    let showsInLast24h = 0;
    if (campaign.dailyCap !== null) {
      const windowStart = new Date(now.getTime() - 24 * 3_600_000);
      const [row] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(triggerLog)
        .where(
          and(
            eq(triggerLog.campaignId, campaign.id),
            eq(triggerLog.userId, input.userId),
            gt(triggerLog.shownAt, windowStart),
          ),
        );
      showsInLast24h = row?.count ?? 0;
    }

    const decision = decide({
      campaign: { minTenureDays: campaign.minTenureDays, dailyCap: campaign.dailyCap },
      suppression: suppression
        ? { nextEligibleAt: suppression.nextEligibleAt, lastAction: suppression.lastAction }
        : undefined,
      repTenureDays: input.repTenureDays,
      showsInLast24h,
      now,
    });
    if (!decision.eligible) return null;

    const nextEligibleAt = cooldownEndsAt(
      campaign.askFrequency,
      now,
      this.opts.noCooldownDebounceSeconds,
    );

    return await this.db.transaction(async (tx) => {
      const claimed = await claimShow(
        tx as unknown as Db,
        input.userId,
        campaign.id,
        now,
        nextEligibleAt,
      );
      if (!claimed) return null; // lost the race — someone else is showing right now
      const [trigger] = await tx
        .insert(triggerLog)
        .values({
          campaignId: campaign.id,
          userId: input.userId,
          clientId: input.clientId,
          screenId: input.screenId,
          shownAt: now,
        })
        .returning();
      if (!trigger) throw new Error('trigger insert returned no row');
      return {
        trigger_id: trigger.id,
        campaign_id: campaign.id,
        metric_type: campaign.metricType,
        header: campaign.headerText,
        rating_type: campaign.ratingType,
        rating_scale_max: campaign.ratingScaleMax,
        positive_threshold: campaign.positiveThreshold,
        chips_on_negative: campaign.chipsOnNegative,
        other_requires_text: campaign.otherRequiresText,
        other_allows_image: campaign.otherAllowsImage,
        on_positive_action: campaign.onPositiveAction,
        skip_enabled: true,
      };
    });
  }
}
