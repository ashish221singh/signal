import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { campaigns, targetRegistry } from '../db/schema.js';
import type { CachedCampaign, CampaignLoader } from './cache.js';

export function makeDbCampaignLoader(db: Db): CampaignLoader {
  return async (): Promise<CachedCampaign[]> => {
    const rows = await db
      .select()
      .from(campaigns)
      .innerJoin(targetRegistry, eq(campaigns.targetId, targetRegistry.id))
      .where(eq(campaigns.status, 'active'));
    const result: CachedCampaign[] = [];
    for (const { campaigns: c, target_registry: t } of rows) {
      // Active campaigns are guaranteed complete by the campaigns_active_complete
      // DB CHECK; this guard narrows the nullable content columns for the type
      // system and defends against any unexpectedly incomplete active row.
      if (
        c.metricType === null ||
        c.ratingType === null ||
        c.ratingScaleMax === null ||
        c.headerText === null ||
        c.positiveThreshold === null
      ) {
        continue;
      }
      result.push({
        id: c.id,
        accountId: c.accountId,
        screenId: t.screenId,
        metricType: c.metricType,
        ratingType: c.ratingType,
        ratingScaleMax: c.ratingScaleMax,
        headerText: c.headerText,
        positiveThreshold: c.positiveThreshold,
        chipsOnNegative: c.chipsOnNegative,
        otherRequiresText: c.otherRequiresText,
        otherAllowsImage: c.otherAllowsImage,
        onPositiveAction: c.onPositiveAction,
        askFrequency: c.askFrequency,
        minTenureDays: c.minTenureDays,
        createdAt: c.createdAt,
      });
    }
    return result;
  };
}
