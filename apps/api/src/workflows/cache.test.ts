import { describe, expect, it } from 'vitest';
import { type CachedWorkflow, WorkflowCache } from './cache.js';

const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function w(partial: Partial<CachedWorkflow>): CachedWorkflow {
  return {
    id: crypto.randomUUID(),
    accountId: ACCOUNT_A,
    eventName: 'checkout_completed',
    samplingRate: 1,
    minSessionAgeDays: null,
    metricType: 'CSAT',
    ratingType: 'star',
    ratingScaleMax: 5,
    headerText: 'h',
    positiveThreshold: 4,
    chipsOnNegative: [],
    otherRequiresText: true,
    otherAllowsImage: false,
    positiveAction: { type: 'none' },
    negativeAction: { type: 'none' },
    askFrequency: 'after_7_days',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    ...partial,
  };
}

describe('WorkflowCache.match', () => {
  it('matches on (account, event)', async () => {
    const a = w({});
    const cache = new WorkflowCache(async () => [a]);
    await cache.refresh();
    expect(cache.match(ACCOUNT_A, 'checkout_completed')?.id).toBe(a.id);
    expect(cache.match(ACCOUNT_A, 'other_event')).toBeUndefined();
  });

  it('does not match another account on the same event (isolation)', async () => {
    const a = w({ accountId: ACCOUNT_A });
    const cache = new WorkflowCache(async () => [a]);
    await cache.refresh();
    expect(cache.match(ACCOUNT_B, 'checkout_completed')).toBeUndefined();
  });

  it('overlapping workflows in an account → oldest created_at wins (B2-D3)', async () => {
    const older = w({ createdAt: new Date('2026-06-01T00:00:00Z') });
    const newer = w({ createdAt: new Date('2026-07-01T00:00:00Z') });
    const cache = new WorkflowCache(async () => [newer, older]);
    await cache.refresh();
    expect(cache.match(ACCOUNT_A, 'checkout_completed')?.id).toBe(older.id);
  });

  it('refresh swaps contents atomically', async () => {
    let rows: CachedWorkflow[] = [w({})];
    const cache = new WorkflowCache(async () => rows);
    await cache.refresh();
    rows = [];
    await cache.refresh();
    expect(cache.match(ACCOUNT_A, 'checkout_completed')).toBeUndefined();
  });
});
