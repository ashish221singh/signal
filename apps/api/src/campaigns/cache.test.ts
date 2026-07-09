import { describe, expect, it } from 'vitest';
import { type CachedCampaign, CampaignCache } from './cache.js';

function c(partial: Partial<CachedCampaign>): CachedCampaign {
  return {
    id: crypto.randomUUID(),
    screenId: 'order_completion',
    clientIds: ['cl_A'],
    metricType: 'CSAT',
    ratingType: 'star',
    ratingScaleMax: 5,
    headerText: 'h',
    positiveThreshold: 4,
    chipsOnNegative: [],
    otherRequiresText: true,
    otherAllowsImage: false,
    onPositiveAction: 'none',
    askFrequency: 'after_7_days',
    minTenureDays: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    ...partial,
  };
}

describe('CampaignCache.match', () => {
  it('matches on screen and client', async () => {
    const a = c({});
    const cache = new CampaignCache(async () => [a]);
    await cache.refresh();
    expect(cache.match('order_completion', 'cl_A')?.id).toBe(a.id);
    expect(cache.match('order_completion', 'cl_B')).toBeUndefined();
    expect(cache.match('other_screen', 'cl_A')).toBeUndefined();
  });
  it('overlapping campaigns → oldest created_at wins (M1-D3)', async () => {
    const older = c({ createdAt: new Date('2026-06-01T00:00:00Z') });
    const newer = c({ createdAt: new Date('2026-07-01T00:00:00Z') });
    const cache = new CampaignCache(async () => [newer, older]);
    await cache.refresh();
    expect(cache.match('order_completion', 'cl_A')?.id).toBe(older.id);
  });
  it('refresh swaps contents atomically', async () => {
    let rows: CachedCampaign[] = [c({})];
    const cache = new CampaignCache(async () => rows);
    await cache.refresh();
    rows = [];
    await cache.refresh();
    expect(cache.match('order_completion', 'cl_A')).toBeUndefined();
  });
});
