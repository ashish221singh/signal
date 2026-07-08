// apps/api/test/schema.int.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema.js';
import { startTestDb } from './testDb.js';

describe('schema', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  it('migrations create all six tables and accept a full row cycle', async () => {
    const [target] = await t.db
      .insert(s.targetRegistry)
      .values({
        name: 'Order Completion',
        screenId: 'order_completion',
        triggerMechanism: 'action',
        integrationStatus: 'confirmed_live',
      })
      .returning();
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
      })
      .returning();
    const [trigger] = await t.db
      .insert(s.triggerLog)
      .values({
        campaignId: campaign!.id,
        userId: 'u_1',
        clientId: 'cl_A',
        screenId: 'order_completion',
        shownAt: new Date(),
      })
      .returning();
    expect(trigger!.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('rejects a second response for the same trigger_id (unique constraint)', async () => {
    await t.truncateAll();
    const [target] = await t.db
      .insert(s.targetRegistry)
      .values({
        name: 'X',
        screenId: 'x',
        triggerMechanism: 'action',
        integrationStatus: 'confirmed_live',
      })
      .returning();
    const [campaign] = await t.db
      .insert(s.campaigns)
      .values({
        targetId: target!.id,
        clientIds: ['cl_A'],
        metricType: 'CSAT',
        ratingType: 'star',
        ratingScaleMax: 5,
        headerText: 'h',
        positiveThreshold: 4,
        chipsOnNegative: [],
        askFrequency: 'no_cooldown',
        status: 'active',
        createdBy: 'test',
      })
      .returning();
    const [trigger] = await t.db
      .insert(s.triggerLog)
      .values({
        campaignId: campaign!.id,
        userId: 'u',
        clientId: 'cl_A',
        screenId: 'x',
        shownAt: new Date(),
      })
      .returning();
    const row = {
      triggerId: trigger!.id,
      campaignId: campaign!.id,
      userId: 'u',
      clientId: 'cl_A',
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
