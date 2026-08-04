// apps/api/test/workflow-schema.int.test.ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as s from '../src/db/schema.js';
import { seedAccount, startTestDb } from './testDb.js';

describe('workflow draft-friendly schema', () => {
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

  it('accepts a draft with NULL content fields (defaults apply)', async () => {
    const [workflow] = await t.db
      .insert(s.workflows)
      .values({
        accountId,
        status: 'draft',
        createdBy: 'test',
        // eventName, metricType, ratingType, ratingScaleMax, headerText,
        // positiveThreshold all omitted -> NULL
        // samplingRate, chipsOnNegative, askFrequency omitted -> defaults
      })
      .returning();

    expect(workflow!.status).toBe('draft');
    expect(workflow!.eventName).toBeNull();
    expect(workflow!.metricType).toBeNull();
    expect(workflow!.ratingType).toBeNull();
    expect(workflow!.ratingScaleMax).toBeNull();
    expect(workflow!.headerText).toBeNull();
    expect(workflow!.positiveThreshold).toBeNull();
    expect(workflow!.minSessionAgeDays).toBeNull();
    expect(workflow!.chipsOnNegative).toEqual([]);
    expect(workflow!.askFrequency).toBe('after_7_days');
    // numeric(4,3) comes back as a string.
    expect(Number(workflow!.samplingRate)).toBe(1);
  });

  it('rejects an INSERT of status=active with a NULL required field', async () => {
    await expect(
      t.db.insert(s.workflows).values({
        accountId,
        status: 'active',
        eventName: 'checkout_completed',
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

  it('accepts status=active with a complete row (event_name + content)', async () => {
    const [workflow] = await t.db
      .insert(s.workflows)
      .values({
        accountId,
        status: 'active',
        eventName: 'checkout_completed',
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
    expect(workflow!.status).toBe('active');
  });

  it('rejects an UPDATE of a draft to status=active while content is NULL', async () => {
    const [draft] = await t.db
      .insert(s.workflows)
      .values({ accountId, status: 'draft', createdBy: 'test' })
      .returning();

    await expect(
      t.db.update(s.workflows).set({ status: 'active' }).where(eq(s.workflows.id, draft!.id)),
    ).rejects.toThrow();
  });

  it('accepts archiving a draft with NULL content (archived is unconstrained)', async () => {
    const [draft] = await t.db
      .insert(s.workflows)
      .values({ accountId, status: 'draft', createdBy: 'test' })
      .returning();

    const [archived] = await t.db
      .update(s.workflows)
      .set({ status: 'archived' })
      .where(eq(s.workflows.id, draft!.id))
      .returning();

    expect(archived!.status).toBe('archived');
    expect(archived!.headerText).toBeNull();
  });
});
