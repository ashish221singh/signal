// apps/api/test/respond.int.test.ts
import type { ResponseBody } from '@signal/contracts';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CampaignCache } from '../src/campaigns/cache.js';
import { makeDbCampaignLoader } from '../src/campaigns/loader.js';
import type { Clock } from '../src/clock.js';
import * as s from '../src/db/schema.js';
import { EligibilityService } from '../src/eligibility/service.js';
import { recordResponse } from '../src/feedback/respond.js';
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

describe('recordResponse (real Postgres)', () => {
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

  /** Grant a real trigger via the eligibility service and return its trigger_id. */
  async function grantTrigger(): Promise<string> {
    const config = await service.check(q);
    expect(config).not.toBeNull();
    return config!.trigger_id;
  }

  function bodyFor(triggerId: string, overrides: Partial<ResponseBody> = {}): ResponseBody {
    return {
      trigger_id: triggerId,
      rating_value: 5,
      device_os: 'android 14',
      app_version: '1.2.3',
      shown_at: '2026-07-08T10:00:00.000Z',
      responded_at: '2026-07-08T10:00:05.000Z',
      ...overrides,
    };
  }

  it('valid response is recorded; suppression → submitted/NULL; never re-ask (M1-D11)', async () => {
    const campaign = await seedCampaign();
    const triggerId = await grantTrigger();

    const result = await recordResponse(t.db, clock, bodyFor(triggerId));
    expect(result).toBe('ok');

    const rows = await t.db.select().from(s.responses);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.triggerId).toBe(triggerId);
    expect(rows[0]!.ratingValue).toBe(5);

    const [supp] = await t.db
      .select()
      .from(s.suppressionState)
      .where(
        and(
          eq(s.suppressionState.userId, q.userId),
          eq(s.suppressionState.campaignId, campaign.id),
        ),
      );
    expect(supp!.lastAction).toBe('submitted');
    expect(supp!.nextEligibleAt).toBeNull();

    // Never re-ask, even far in the future.
    clock.advanceHours(1000);
    expect(await service.check(q)).toBeNull();
  });

  it('idempotency (M1-D2): same body twice → ok both times, exactly one row', async () => {
    await seedCampaign();
    const triggerId = await grantTrigger();
    const body = bodyFor(triggerId);

    expect(await recordResponse(t.db, clock, body)).toBe('ok');
    expect(await recordResponse(t.db, clock, body)).toBe('ok');

    expect(await t.db.select().from(s.responses)).toHaveLength(1);
  });

  it('unknown trigger_id → unknown_trigger', async () => {
    await seedCampaign();
    const random = '00000000-0000-4000-8000-000000000000';
    expect(await recordResponse(t.db, clock, bodyFor(random))).toBe('unknown_trigger');
  });

  it('rating out of range for emoji campaign → invalid_rating (M1-D13)', async () => {
    await seedCampaign({ ratingType: 'emoji', ratingScaleMax: 3 });
    const triggerId = await grantTrigger();
    // emoji bounds are 1..3; 4 is out of range even though schema allows 1..5.
    expect(await recordResponse(t.db, clock, bodyFor(triggerId, { rating_value: 4 }))).toBe(
      'invalid_rating',
    );
    expect(await t.db.select().from(s.responses)).toHaveLength(0);
  });

  it('campaign paused after trigger granted → still accepted (M1-D12)', async () => {
    const campaign = await seedCampaign();
    const triggerId = await grantTrigger();

    await t.db.update(s.campaigns).set({ status: 'paused' }).where(eq(s.campaigns.id, campaign.id));

    expect(await recordResponse(t.db, clock, bodyFor(triggerId))).toBe('ok');
    expect(await t.db.select().from(s.responses)).toHaveLength(1);
  });

  it('chip_selected not in campaign chip list → accepted, stored verbatim (M1-D13)', async () => {
    await seedCampaign();
    const triggerId = await grantTrigger();

    const result = await recordResponse(
      t.db,
      clock,
      bodyFor(triggerId, { rating_value: 2, chip_selected: 'Not A Real Chip' }),
    );
    expect(result).toBe('ok');

    const rows = await t.db.select().from(s.responses);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.chipSelected).toBe('Not A Real Chip');
  });
});
