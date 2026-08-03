// apps/api/test/campaign-schema.int.test.ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema.js';
import { seedAccount, startTestDb } from './testDb.js';

describe('campaign draft-friendly schema', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let accountId: string;
  let targetId: string;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    accountId = await seedAccount(t.db);
    const [target] = await t.db
      .insert(s.targetRegistry)
      .values({
        accountId,
        name: 'Order Completion',
        screenId: 'order_completion',
        triggerMechanism: 'action',
        integrationStatus: 'confirmed_live',
      })
      .returning();
    targetId = target!.id;
  });

  it('accepts a draft with NULL content fields (defaults apply)', async () => {
    const [campaign] = await t.db
      .insert(s.campaigns)
      .values({
        accountId,
        status: 'draft',
        createdBy: 'test',
        // targetId, metricType, ratingType, ratingScaleMax, headerText,
        // positiveThreshold all omitted -> NULL
        // chipsOnNegative, askFrequency omitted -> defaults
      })
      .returning();

    expect(campaign!.status).toBe('draft');
    expect(campaign!.targetId).toBeNull();
    expect(campaign!.metricType).toBeNull();
    expect(campaign!.ratingType).toBeNull();
    expect(campaign!.ratingScaleMax).toBeNull();
    expect(campaign!.headerText).toBeNull();
    expect(campaign!.positiveThreshold).toBeNull();
    expect(campaign!.chipsOnNegative).toEqual([]);
    expect(campaign!.askFrequency).toBe('after_7_days');
  });

  it('rejects an INSERT of status=active with a NULL required field', async () => {
    await expect(
      t.db.insert(s.campaigns).values({
        accountId,
        status: 'active',
        targetId,
        metricType: 'CSAT',
        ratingType: 'star',
        ratingScaleMax: 5,
        // headerText omitted -> NULL -> CHECK violation
        positiveThreshold: 4,
        chipsOnNegative: [],
        askFrequency: 'after_7_days',
        createdBy: 'test',
      }),
    ).rejects.toThrow();
  });

  it('accepts status=active WITHOUT any client_ids clause (B1-D6 dropped it)', async () => {
    const [campaign] = await t.db
      .insert(s.campaigns)
      .values({
        accountId,
        status: 'active',
        targetId,
        metricType: 'CSAT',
        ratingType: 'star',
        ratingScaleMax: 5,
        headerText: 'How was it?',
        positiveThreshold: 4,
        chipsOnNegative: ['Slow'],
        askFrequency: 'after_7_days',
        createdBy: 'test',
      })
      .returning();
    expect(campaign!.status).toBe('active');
  });

  it('rejects an UPDATE of a draft to status=active while content is NULL', async () => {
    const [draft] = await t.db
      .insert(s.campaigns)
      .values({ accountId, status: 'draft', createdBy: 'test' })
      .returning();

    await expect(
      t.db.update(s.campaigns).set({ status: 'active' }).where(eq(s.campaigns.id, draft!.id)),
    ).rejects.toThrow();
  });

  it('accepts archiving a draft with NULL content (archived is unconstrained)', async () => {
    const [draft] = await t.db
      .insert(s.campaigns)
      .values({ accountId, status: 'draft', createdBy: 'test' })
      .returning();

    const [archived] = await t.db
      .update(s.campaigns)
      .set({ status: 'archived' })
      .where(eq(s.campaigns.id, draft!.id))
      .returning();

    expect(archived!.status).toBe('archived');
    expect(archived!.headerText).toBeNull();
  });
});
