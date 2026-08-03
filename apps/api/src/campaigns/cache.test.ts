import { describe, expect, it } from 'vitest';
import { type CachedCampaign, CampaignCache } from './cache.js';

const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function c(partial: Partial<CachedCampaign>): CachedCampaign {
  return {
    id: crypto.randomUUID(),
    accountId: ACCOUNT_A,
    screenId: 'order_completion',
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
  it('matches on (account, screen)', async () => {
    const a = c({});
    const cache = new CampaignCache(async () => [a]);
    await cache.refresh();
    expect(cache.match(ACCOUNT_A, 'order_completion')?.id).toBe(a.id);
    expect(cache.match(ACCOUNT_A, 'other_screen')).toBeUndefined();
  });

  it('does not match another account on the same screen (isolation)', async () => {
    const a = c({ accountId: ACCOUNT_A });
    const cache = new CampaignCache(async () => [a]);
    await cache.refresh();
    expect(cache.match(ACCOUNT_B, 'order_completion')).toBeUndefined();
  });

  it('overlapping campaigns in an account → oldest created_at wins (M1-D3)', async () => {
    const older = c({ createdAt: new Date('2026-06-01T00:00:00Z') });
    const newer = c({ createdAt: new Date('2026-07-01T00:00:00Z') });
    const cache = new CampaignCache(async () => [newer, older]);
    await cache.refresh();
    expect(cache.match(ACCOUNT_A, 'order_completion')?.id).toBe(older.id);
  });

  it('refresh swaps contents atomically', async () => {
    let rows: CachedCampaign[] = [c({})];
    const cache = new CampaignCache(async () => rows);
    await cache.refresh();
    rows = [];
    await cache.refresh();
    expect(cache.match(ACCOUNT_A, 'order_completion')).toBeUndefined();
  });
});
