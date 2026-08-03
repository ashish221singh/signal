// apps/api/test/schema.int.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema.js';
import { seedAccount, startTestDb } from './testDb.js';

describe('schema', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
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
  });

  it('accepts a full account-scoped row cycle (account → target → campaign → trigger)', async () => {
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
      })
      .returning();
    const [trigger] = await t.db
      .insert(s.triggerLog)
      .values({
        accountId,
        campaignId: campaign!.id,
        userId: 'u_1',
        screenId: 'order_completion',
        shownAt: new Date(),
      })
      .returning();
    expect(trigger!.id).toMatch(/[0-9a-f-]{36}/);
    expect(trigger!.accountId).toBe(accountId);
  });

  it('publishable keys are unique across accounts', async () => {
    const other = await seedAccount(t.db, 'Other');
    await t.db
      .insert(s.apiKeys)
      .values({ accountId, key: 'pk_test_dupe', label: 'a', environment: 'test' });
    await expect(
      t.db
        .insert(s.apiKeys)
        .values({ accountId: other, key: 'pk_test_dupe', label: 'b', environment: 'test' }),
    ).rejects.toThrow();
  });

  it('screen_id is unique per account but reusable across accounts', async () => {
    const other = await seedAccount(t.db, 'Other');
    await t.db.insert(s.targetRegistry).values({
      accountId,
      name: 'X',
      screenId: 'x',
      triggerMechanism: 'action',
    });
    // Same screen_id under a DIFFERENT account is fine.
    await t.db.insert(s.targetRegistry).values({
      accountId: other,
      name: 'X',
      screenId: 'x',
      triggerMechanism: 'action',
    });
    // Same screen_id under the SAME account collides.
    await expect(
      t.db.insert(s.targetRegistry).values({
        accountId,
        name: 'X2',
        screenId: 'x',
        triggerMechanism: 'action',
      }),
    ).rejects.toThrow();
  });

  it('rejects a second response for the same trigger_id (unique constraint)', async () => {
    const [target] = await t.db
      .insert(s.targetRegistry)
      .values({ accountId, name: 'X', screenId: 'x', triggerMechanism: 'action' })
      .returning();
    const [campaign] = await t.db
      .insert(s.campaigns)
      .values({
        accountId,
        targetId: target!.id,
        metricType: 'CSAT',
        ratingType: 'star',
        ratingScaleMax: 5,
        headerText: 'h',
        positiveThreshold: 4,
        chipsOnNegative: [],
        askFrequency: 'after_7_days',
        status: 'active',
        createdBy: 'test',
      })
      .returning();
    const [trigger] = await t.db
      .insert(s.triggerLog)
      .values({
        accountId,
        campaignId: campaign!.id,
        userId: 'u',
        screenId: 'x',
        shownAt: new Date(),
      })
      .returning();
    const row = {
      accountId,
      triggerId: trigger!.id,
      campaignId: campaign!.id,
      userId: 'u',
      screenId: 'x',
      ratingValue: 5,
      deviceOs: 'Android',
      appVersion: '1',
      shownAt: new Date(),
      respondedAt: new Date(),
    };
    await t.db.insert(s.responses).values(row);
    await expect(t.db.insert(s.responses).values(row)).rejects.toThrow();
  });
});
