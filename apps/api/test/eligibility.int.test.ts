// apps/api/test/eligibility.int.test.ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CampaignCache } from '../src/campaigns/cache.js';
import { makeDbCampaignLoader } from '../src/campaigns/loader.js';
import type { Clock } from '../src/clock.js';
import * as s from '../src/db/schema.js';
import { EligibilityService } from '../src/eligibility/service.js';
import { startTestDb } from './testDb.js';

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

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    clock = new FakeClock(new Date('2026-07-08T10:00:00Z'));
    cache = new CampaignCache(makeDbCampaignLoader(t.db));
    service = new EligibilityService(t.db, cache, clock, { noCooldownDebounceSeconds: 60 });
  });

  async function seedCampaign(overrides: Partial<typeof s.campaigns.$inferInsert> = {}) {
    const [inserted] = await t.db
      .insert(s.targetRegistry)
      .values({
        name: 'Order Completion',
        screenId: 'order_completion',
        triggerMechanism: 'action',
        integrationStatus: 'confirmed_live',
      })
      .onConflictDoNothing()
      .returning();
    const target =
      inserted ??
      (
        await t.db
          .select()
          .from(s.targetRegistry)
          .where(eq(s.targetRegistry.screenId, 'order_completion'))
      )[0];
    const [campaign] = await t.db
      .insert(s.campaigns)
      .values({
        targetId: target!.id,
        clientIds: ['cl_A'],
        metricType: 'CSAT',
        ratingType: 'star',
        ratingScaleMax: 5,
        headerText: 'How was it?',
        positiveThreshold: 4,
        chipsOnNegative: ['Slow'],
        askFrequency: 'once_per_week',
        status: 'active',
        createdBy: 'test',
        ...overrides,
      })
      .returning();
    await cache.refresh();
    return campaign!;
  }

  const q = { screenId: 'order_completion', userId: 'u_1', clientId: 'cl_A' } as const;

  it('never-asked user gets config with trigger_id; a TriggerLog row exists', async () => {
    await seedCampaign();
    const result = await service.check(q);
    expect(result).not.toBeNull();
    expect(result!.trigger_id).toMatch(/[0-9a-f-]{36}/);
    const logs = await t.db.select().from(s.triggerLog);
    expect(logs).toHaveLength(1);
  });

  it('no matching campaign → null, and NO TriggerLog row', async () => {
    const result = await service.check(q);
    expect(result).toBeNull();
    expect(await t.db.select().from(s.triggerLog)).toHaveLength(0);
  });

  it('immediately after a show → suppressed (provisional cooldown, M1-D10)', async () => {
    await seedCampaign();
    expect(await service.check(q)).not.toBeNull();
    expect(await service.check(q)).toBeNull();
  });

  it('weekly cooldown: still suppressed at +167h, eligible at +169h', async () => {
    await seedCampaign();
    await service.check(q);
    clock.advanceHours(167);
    expect(await service.check(q)).toBeNull();
    clock.advanceHours(2);
    expect(await service.check(q)).not.toBeNull();
  });

  it('tenure gate: 89 days → null; 90 → config; unknown → null (fail closed)', async () => {
    await seedCampaign({ minTenureDays: 90 });
    expect(await service.check({ ...q, repTenureDays: 89 })).toBeNull();
    expect(await service.check({ ...q, repTenureDays: 90 })).not.toBeNull();
    await t.db.delete(s.suppressionState);
    expect(await service.check({ ...q, userId: 'u_2' })).toBeNull();
  });

  it('daily cap 2 on no_cooldown: third show within 24h → null; window rolls → eligible', async () => {
    await seedCampaign({ askFrequency: 'no_cooldown', dailyCap: 2 });
    expect(await service.check(q)).not.toBeNull();
    clock.advanceHours(1);
    expect(await service.check(q)).not.toBeNull();
    clock.advanceHours(1);
    expect(await service.check(q)).toBeNull(); // cap hit
    clock.advanceHours(23); // first show now >24h old
    expect(await service.check(q)).not.toBeNull();
  });

  it('no_cooldown debounce: immediate second call → null (M1-D6)', async () => {
    await seedCampaign({ askFrequency: 'no_cooldown' });
    expect(await service.check(q)).not.toBeNull();
    expect(await service.check(q)).toBeNull();
  });

  it('THE RACE: two concurrent checks → exactly one config, one TriggerLog row (M1-D9)', async () => {
    await seedCampaign();
    const [a, b] = await Promise.all([service.check(q), service.check(q)]);
    const granted = [a, b].filter((r) => r !== null);
    expect(granted).toHaveLength(1);
    expect(await t.db.select().from(s.triggerLog)).toHaveLength(1);
  });

  it('two campaigns, same screen, different clients — independent suppression', async () => {
    await seedCampaign();
    await seedCampaign({ clientIds: ['cl_B'] });
    expect(await service.check(q)).not.toBeNull();
    expect(await service.check({ ...q, clientId: 'cl_B' })).not.toBeNull();
  });
});
