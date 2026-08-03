// apps/api/test/eligibility.int.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CampaignCache } from '../src/campaigns/cache.js';
import { makeDbCampaignLoader } from '../src/campaigns/loader.js';
import type { Clock } from '../src/clock.js';
import * as s from '../src/db/schema.js';
import { EligibilityService } from '../src/eligibility/service.js';
import { seedAccount, startTestDb } from './testDb.js';

class FakeClock implements Clock {
  constructor(private current: Date) {}
  now() {
    return this.current;
  }
  advanceHours(h: number) {
    this.current = new Date(this.current.getTime() + h * 3_600_000);
  }
}

describe('EligibilityService (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let clock: FakeClock;
  let service: EligibilityService;
  let cache: CampaignCache;
  let accountId: string;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    accountId = await seedAccount(t.db);
    clock = new FakeClock(new Date('2026-07-08T10:00:00Z'));
    cache = new CampaignCache(makeDbCampaignLoader(t.db));
    service = new EligibilityService(t.db, cache, clock);
  });

  async function seedCampaign(overrides: Partial<typeof s.campaigns.$inferInsert> = {}) {
    const [target] = await t.db
      .insert(s.targetRegistry)
      .values({
        accountId,
        name: 'Order Completion',
        screenId: 'order_completion',
        triggerMechanism: 'action',
        integrationStatus: 'confirmed_live',
      })
      .onConflictDoNothing()
      .returning();
    const [campaign] = await t.db
      .insert(s.campaigns)
      .values({
        accountId,
        targetId: target!.id,
        metricType: 'CSAT',
        ratingType: 'star',
        ratingScaleMax: 5,
        headerText: 'How was it?',
        positiveThreshold: 4,
        chipsOnNegative: ['Slow'],
        askFrequency: 'after_7_days',
        status: 'active',
        createdBy: 'test',
        ...overrides,
      })
      .returning();
    await cache.refresh();
    return campaign!;
  }

  function q(overrides: Partial<Parameters<EligibilityService['check']>[0]> = {}) {
    return { accountId, screenId: 'order_completion', userId: 'u_1', ...overrides };
  }

  it('never-asked user gets config with trigger_id; a TriggerLog row exists', async () => {
    await seedCampaign();
    const result = await service.check(q());
    expect(result).not.toBeNull();
    expect(result!.trigger_id).toMatch(/[0-9a-f-]{36}/);
    const logs = await t.db.select().from(s.triggerLog);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.accountId).toBe(accountId);
  });

  it('no matching campaign → null, and NO TriggerLog row', async () => {
    const result = await service.check(q());
    expect(result).toBeNull();
    expect(await t.db.select().from(s.triggerLog)).toHaveLength(0);
  });

  it('immediately after a show → suppressed (provisional cooldown, M1-D10)', async () => {
    await seedCampaign();
    expect(await service.check(q())).not.toBeNull();
    expect(await service.check(q())).toBeNull();
  });

  it('7-day cooldown: still suppressed at +167h, eligible at +169h', async () => {
    await seedCampaign();
    await service.check(q());
    clock.advanceHours(167);
    expect(await service.check(q())).toBeNull();
    clock.advanceHours(2);
    expect(await service.check(q())).not.toBeNull();
  });

  it('tenure gate: 89 days → null; 90 → config; unknown → null (fail closed)', async () => {
    await seedCampaign({ minTenureDays: 90 });
    expect(await service.check(q({ repTenureDays: 89 }))).toBeNull();
    expect(await service.check(q({ repTenureDays: 90 }))).not.toBeNull();
    await t.db.delete(s.suppressionState);
    expect(await service.check(q({ userId: 'u_2' }))).toBeNull();
  });

  it('THE RACE: two concurrent checks → exactly one config, one TriggerLog row (M1-D9)', async () => {
    await seedCampaign();
    const [a, b] = await Promise.all([service.check(q()), service.check(q())]);
    const granted = [a, b].filter((r) => r !== null);
    expect(granted).toHaveLength(1);
    expect(await t.db.select().from(s.triggerLog)).toHaveLength(1);
  });

  it("isolation: a key for account B cannot trigger account A's campaign", async () => {
    await seedCampaign();
    const otherAccount = await seedAccount(t.db, 'Other');
    // Same screen id, different account → no match on the hot path.
    const result = await service.check(q({ accountId: otherAccount }));
    expect(result).toBeNull();
    expect(await t.db.select().from(s.triggerLog)).toHaveLength(0);
  });
});
