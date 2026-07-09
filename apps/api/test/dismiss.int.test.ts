// apps/api/test/dismiss.int.test.ts
import type { DismissBody } from '@signal/contracts';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CampaignCache } from '../src/campaigns/cache.js';
import { makeDbCampaignLoader } from '../src/campaigns/loader.js';
import type { Clock } from '../src/clock.js';
import * as s from '../src/db/schema.js';
import { EligibilityService } from '../src/eligibility/service.js';
import { recordDismiss } from '../src/feedback/dismiss.js';
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

const DEBOUNCE = 60;

describe('recordDismiss (real Postgres)', () => {
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
    // Same clock instance flows into both the service and dismiss so "server now" is the fake time.
    service = new EligibilityService(t.db, cache, clock, { noCooldownDebounceSeconds: DEBOUNCE });
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

  function dismissBody(triggerId: string): DismissBody {
    return {
      trigger_id: triggerId,
      shown_at: '2026-07-08T10:00:00.000Z',
      dismissed_at: '2026-07-08T10:00:05.000Z',
    };
  }

  async function suppRow(campaignId: string) {
    const [row] = await t.db
      .select()
      .from(s.suppressionState)
      .where(
        and(eq(s.suppressionState.userId, q.userId), eq(s.suppressionState.campaignId, campaignId)),
      );
    return row!;
  }

  it('dismiss sets cooldown from server now; suppressed until it ends (M1-D5/D10)', async () => {
    const campaign = await seedCampaign();
    const triggerId = await grantTrigger();
    const serverNow = clock.now();

    expect(
      await recordDismiss(t.db, clock, dismissBody(triggerId), {
        noCooldownDebounceSeconds: DEBOUNCE,
      }),
    ).toBe('ok');

    const row = await suppRow(campaign.id);
    expect(row.lastAction).toBe('dismissed');
    // weekly campaign → +168h from server now.
    expect(row.nextEligibleAt).toEqual(new Date(serverNow.getTime() + 168 * 3_600_000));

    // Prove via the service: still suppressed at +167h, eligible at +169h.
    clock.advanceHours(167);
    expect(await service.check(q)).toBeNull();
    clock.advanceHours(2); // now +169h
    expect(await service.check(q)).not.toBeNull();
  });

  it('idempotent: second dismiss is a no-op, cooldown stays anchored to first dismiss', async () => {
    const campaign = await seedCampaign();
    const triggerId = await grantTrigger();
    const firstNow = clock.now();

    expect(
      await recordDismiss(t.db, clock, dismissBody(triggerId), {
        noCooldownDebounceSeconds: DEBOUNCE,
      }),
    ).toBe('ok');

    // Advance the clock before the second call.
    clock.advanceHours(3);
    expect(
      await recordDismiss(t.db, clock, dismissBody(triggerId), {
        noCooldownDebounceSeconds: DEBOUNCE,
      }),
    ).toBe('ok');

    const row = await suppRow(campaign.id);
    // Anchored to the FIRST dismiss (+168h), NOT the second (which would be +171h).
    expect(row.nextEligibleAt).toEqual(new Date(firstNow.getTime() + 168 * 3_600_000));
    expect(row.nextEligibleAt).not.toEqual(new Date(firstNow.getTime() + (168 + 3) * 3_600_000));
  });

  it('unknown trigger → unknown_trigger', async () => {
    await seedCampaign();
    const random = '00000000-0000-4000-8000-000000000000';
    expect(
      await recordDismiss(t.db, clock, dismissBody(random), {
        noCooldownDebounceSeconds: DEBOUNCE,
      }),
    ).toBe('unknown_trigger');
  });

  it('submitted wins: dismiss after a recorded response is a no-op', async () => {
    const campaign = await seedCampaign();
    const triggerId = await grantTrigger();

    // Record a real response first → last_action='submitted', next_eligible_at=NULL.
    expect(
      await recordResponse(t.db, clock, {
        trigger_id: triggerId,
        rating_value: 5,
        device_os: 'android 14',
        app_version: '1.2.3',
        shown_at: '2026-07-08T10:00:00.000Z',
        responded_at: '2026-07-08T10:00:05.000Z',
      }),
    ).toBe('ok');

    const before = await suppRow(campaign.id);
    expect(before.lastAction).toBe('submitted');
    expect(before.nextEligibleAt).toBeNull();

    // Now dismiss the same trigger → returns 'ok' but matches no rows (guard: last_action IS NULL).
    clock.advanceHours(1);
    expect(
      await recordDismiss(t.db, clock, dismissBody(triggerId), {
        noCooldownDebounceSeconds: DEBOUNCE,
      }),
    ).toBe('ok');

    const after = await suppRow(campaign.id);
    expect(after.lastAction).toBe('submitted');
    expect(after.nextEligibleAt).toBeNull();
  });
});
