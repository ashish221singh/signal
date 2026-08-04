// apps/api/test/eligibility.int.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '../src/clock.js';
import * as s from '../src/db/schema.js';
import { EligibilityService } from '../src/eligibility/service.js';
import { WorkflowCache } from '../src/workflows/cache.js';
import { makeDbWorkflowLoader } from '../src/workflows/loader.js';
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
  let cache: WorkflowCache;
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
    cache = new WorkflowCache(makeDbWorkflowLoader(t.db));
    // Default rng always samples in (0 < rate), so sampling never skips unless a
    // test builds its own service with a stubbed rng.
    service = new EligibilityService(t.db, cache, clock, () => 0);
  });

  async function seedWorkflow(overrides: Partial<typeof s.workflows.$inferInsert> = {}) {
    const [workflow] = await t.db
      .insert(s.workflows)
      .values({
        accountId,
        eventName: 'checkout_completed',
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
    return workflow!;
  }

  function q(overrides: Partial<Parameters<EligibilityService['check']>[0]> = {}) {
    return { accountId, eventName: 'checkout_completed', userId: 'u_1', ...overrides };
  }

  it('never-asked user gets config with trigger_id; a TriggerLog row exists', async () => {
    await seedWorkflow();
    const result = await service.check(q());
    expect(result).not.toBeNull();
    expect(result!.trigger_id).toMatch(/[0-9a-f-]{36}/);
    const logs = await t.db.select().from(s.triggerLog);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.accountId).toBe(accountId);
    expect(logs[0]!.eventName).toBe('checkout_completed');
  });

  // B5-D3: the resolved branched actions ride inline in the eligibility config.
  it('config carries the workflow’s resolved positive/negative actions', async () => {
    await seedWorkflow({
      positiveAction: { type: 'store_review' },
      negativeAction: { type: 'redirect', url: 'https://support.example.com' },
    });
    const result = await service.check(q({ userId: 'u_actions' }));
    expect(result).not.toBeNull();
    expect(result!.positive_action).toEqual({ type: 'store_review' });
    expect(result!.negative_action).toEqual({
      type: 'redirect',
      url: 'https://support.example.com',
    });
  });

  it('stores the optional context on the trigger', async () => {
    await seedWorkflow();
    await service.check(q({ context: 'OrderSummaryScreen' }));
    const [log] = await t.db.select().from(s.triggerLog);
    expect(log!.context).toBe('OrderSummaryScreen');
  });

  it('no matching workflow → null, and NO TriggerLog row', async () => {
    const result = await service.check(q());
    expect(result).toBeNull();
    expect(await t.db.select().from(s.triggerLog)).toHaveLength(0);
  });

  it('immediately after a show → suppressed (provisional cooldown, M1-D10)', async () => {
    await seedWorkflow();
    expect(await service.check(q())).not.toBeNull();
    expect(await service.check(q())).toBeNull();
  });

  it('7-day cooldown: still suppressed at +167h, eligible at +169h', async () => {
    await seedWorkflow();
    await service.check(q());
    clock.advanceHours(167);
    expect(await service.check(q())).toBeNull();
    clock.advanceHours(2);
    expect(await service.check(q())).not.toBeNull();
  });

  it('session-age gate: 89 days → null; 90 → config; unknown → null (fail closed)', async () => {
    await seedWorkflow({ minSessionAgeDays: 90 });
    expect(await service.check(q({ sessionAgeDays: 89 }))).toBeNull();
    expect(await service.check(q({ sessionAgeDays: 90 }))).not.toBeNull();
    await t.db.delete(s.suppressionState);
    expect(await service.check(q({ userId: 'u_2' }))).toBeNull();
  });

  describe('sampling (B2-D4, stubbed rng)', () => {
    it('not-sampled trigger returns null and writes NO trigger/suppression row', async () => {
      await seedWorkflow({ samplingRate: '0.500' });
      // rng >= rate → not sampled.
      const notSampled = new EligibilityService(t.db, cache, clock, () => 0.9);
      expect(await notSampled.check(q())).toBeNull();
      expect(await t.db.select().from(s.triggerLog)).toHaveLength(0);
      expect(await t.db.select().from(s.suppressionState)).toHaveLength(0);
    });

    it('not-sampled does NOT consume cooldown — a later sampled call still fires', async () => {
      await seedWorkflow({ samplingRate: '0.500' });
      const notSampled = new EligibilityService(t.db, cache, clock, () => 0.9);
      expect(await notSampled.check(q())).toBeNull();
      // A subsequent call that DOES sample must still be eligible.
      const sampled = new EligibilityService(t.db, cache, clock, () => 0.1);
      expect(await sampled.check(q())).not.toBeNull();
      expect(await t.db.select().from(s.triggerLog)).toHaveLength(1);
    });
  });

  it('THE RACE: two concurrent checks → exactly one config, one TriggerLog row (M1-D9)', async () => {
    await seedWorkflow();
    const [a, b] = await Promise.all([service.check(q()), service.check(q())]);
    const granted = [a, b].filter((r) => r !== null);
    expect(granted).toHaveLength(1);
    expect(await t.db.select().from(s.triggerLog)).toHaveLength(1);
  });

  it('oldest-wins tie-break across two same-event workflows (B2-D3 runtime)', async () => {
    // The DB partial unique index forbids two ACTIVE workflows on one event, so
    // the runtime tie-break guards any transient overlap the index cannot catch
    // (e.g. mid-refresh). Prove it by driving the cache directly with two rows
    // sharing the event; the oldest created_at must win.
    const twoRowCache = new WorkflowCache(async () => [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        accountId,
        eventName: 'checkout_completed',
        samplingRate: 1,
        minSessionAgeDays: null,
        metricType: 'CSAT',
        ratingType: 'star',
        ratingScaleMax: 5,
        headerText: 'older',
        positiveThreshold: 4,
        chipsOnNegative: [],
        otherRequiresText: true,
        otherAllowsImage: false,
        positiveAction: { type: 'none' },
        negativeAction: { type: 'none' },
        askFrequency: 'after_7_days',
        createdAt: new Date('2026-06-01T00:00:00Z'),
      },
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        accountId,
        eventName: 'checkout_completed',
        samplingRate: 1,
        minSessionAgeDays: null,
        metricType: 'CSAT',
        ratingType: 'star',
        ratingScaleMax: 5,
        headerText: 'newer',
        positiveThreshold: 4,
        chipsOnNegative: [],
        otherRequiresText: true,
        otherAllowsImage: false,
        positiveAction: { type: 'none' },
        negativeAction: { type: 'none' },
        askFrequency: 'after_7_days',
        createdAt: new Date('2026-07-01T00:00:00Z'),
      },
    ]);
    await twoRowCache.refresh();
    const match = twoRowCache.match(accountId, 'checkout_completed');
    expect(match?.headerText).toBe('older');
  });

  it("isolation: a key for account B cannot trigger account A's workflow", async () => {
    await seedWorkflow();
    const otherAccount = await seedAccount(t.db, 'Other');
    // Same event name, different account → no match on the hot path.
    const result = await service.check(q({ accountId: otherAccount }));
    expect(result).toBeNull();
    expect(await t.db.select().from(s.triggerLog)).toHaveLength(0);
  });
});
