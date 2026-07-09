// apps/api/test/console-reporting.int.test.ts
import { campaignOverviewSchema } from '@signal/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import { parseEnv } from '../src/env.js';
import { startTestDb } from './testDb.js';

const env = parseEnv({ NODE_ENV: 'test', SIGNAL_APP_KEYS: 'test-app-key' });

const USER_ID = '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

/** Seed an active campaign with a known positive_threshold; returns its id. */
async function seedActiveCampaign(
  db: Db,
  overrides: Partial<typeof s.campaigns.$inferInsert> = {},
): Promise<string> {
  const [target] = await db
    .insert(s.targetRegistry)
    .values({
      name: 'Alpha Screen',
      screenId: `alpha-${Math.random().toString(36).slice(2, 8)}`,
      triggerMechanism: 'action',
      integrationStatus: 'confirmed_live',
    })
    .returning();
  if (!target) throw new Error('target seed returned no row');
  const [row] = await db
    .insert(s.campaigns)
    .values({
      targetId: target.id,
      clientIds: ['cl_A'],
      metricType: 'CSAT',
      ratingType: 'star',
      ratingScaleMax: 5,
      headerText: 'How was it?',
      positiveThreshold: 4,
      status: 'active',
      createdBy: USER_ID,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('campaign seed returned no row');
  return row.id;
}

/** Insert one trigger_log row for a campaign; returns its id. */
async function seedTrigger(db: Db, campaignId: string): Promise<string> {
  const [trigger] = await db
    .insert(s.triggerLog)
    .values({
      campaignId,
      userId: 'u',
      clientId: 'cl_A',
      screenId: 'alpha',
      shownAt: new Date(),
    })
    .returning();
  if (!trigger) throw new Error('trigger seed returned no row');
  return trigger.id;
}

/** Insert a trigger + a response with a KNOWN rating_value for a campaign. */
async function seedResponseWithRating(
  db: Db,
  campaignId: string,
  ratingValue: number,
): Promise<void> {
  const triggerId = await seedTrigger(db, campaignId);
  await db.insert(s.responses).values({
    triggerId,
    campaignId,
    userId: 'u',
    clientId: 'cl_A',
    screenId: 'alpha',
    ratingValue,
    deviceOs: 'Android',
    appVersion: '1',
    shownAt: new Date(),
    respondedAt: new Date(),
  });
}

describe('GET /v1/console/campaigns/:id/overview (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookieHeader: string;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    app = await buildApp(env, { db: t.db, closeDb: async () => {} });
    const signed = app.signCookie(USER_ID);
    cookieHeader = `signal_session=${signed}`;
  });
  afterEach(async () => {
    await app.close();
  });

  it('without a cookie → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/campaigns/${UNKNOWN_ID}/overview`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('unknown id → 404 not_found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/campaigns/${UNKNOWN_ID}/overview`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('counts triggers/responses and computes response_rate + positive_score', async () => {
    // threshold 4; 5 triggers; 3 responses with ratings 5,4,2 → positiveCount = 2.
    const id = await seedActiveCampaign(t.db, { positiveThreshold: 4 });
    // Two extra triggers with no response (5 triggers total).
    await seedTrigger(t.db, id);
    await seedTrigger(t.db, id);
    await seedResponseWithRating(t.db, id, 5);
    await seedResponseWithRating(t.db, id, 4);
    await seedResponseWithRating(t.db, id, 2);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/campaigns/${id}/overview`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(campaignOverviewSchema.safeParse(body).success).toBe(true);
    expect(body.campaign_id).toBe(id);
    expect(body.triggers).toBe(5);
    expect(body.responses).toBe(3);
    expect(body.response_rate).toBeCloseTo(3 / 5, 10); // 0.6
    expect(body.positive_score).toBeCloseTo(2 / 3, 10); // ≈0.6667
  });

  it('zero triggers and zero responses → response_rate=null, positive_score=null', async () => {
    const id = await seedActiveCampaign(t.db);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/campaigns/${id}/overview`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.triggers).toBe(0);
    expect(body.responses).toBe(0);
    expect(body.response_rate).toBeNull();
    expect(body.positive_score).toBeNull();
  });

  it('triggers>0 but zero responses → response_rate=0, positive_score=null', async () => {
    const id = await seedActiveCampaign(t.db);
    await seedTrigger(t.db, id);
    await seedTrigger(t.db, id);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/campaigns/${id}/overview`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.triggers).toBe(2);
    expect(body.responses).toBe(0);
    expect(body.response_rate).toBe(0);
    expect(body.positive_score).toBeNull();
  });

  it('a campaign with a null positive_threshold → positive_score=null even with responses', async () => {
    const id = await seedActiveCampaign(t.db, {
      status: 'draft',
      positiveThreshold: null,
    });
    await seedResponseWithRating(t.db, id, 5);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/campaigns/${id}/overview`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.responses).toBe(1);
    expect(body.positive_score).toBeNull();
    expect(body.response_rate).toBe(1); // 1 response / 1 trigger
  });
});
