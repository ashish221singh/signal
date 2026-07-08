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
    return rows.map(({ campaigns: c, target_registry: t }) => ({
      id: c.id,
      screenId: t.screenId,
      clientIds: c.clientIds,
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
      dailyCap: c.dailyCap,
      minTenureDays: c.minTenureDays,
      createdAt: c.createdAt,
    }));
  };
}
