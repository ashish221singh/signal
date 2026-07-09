// apps/api/test/console-reporting.int.test.ts
import {
  campaignOverviewSchema,
  clientBreakdownSchema,
  dashboardSummarySchema,
  reasonsSchema,
} from '@signal/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Clock } from '../src/clock.js';
import type { Db } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import { parseEnv } from '../src/env.js';
import { startTestDb } from './testDb.js';

/** Fixed clock so the rolling 30-day window has a deterministic "now". */
class FixedClock implements Clock {
  constructor(private current: Date) {}
  now() {
    return this.current;
  }
}

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

/** Insert one trigger_log row attributed to a specific client. */
async function seedTriggerForClient(db: Db, campaignId: string, clientId: string): Promise<string> {
  const [trigger] = await db
    .insert(s.triggerLog)
    .values({
      campaignId,
      userId: 'u',
      clientId,
      screenId: 'alpha',
      shownAt: new Date(),
    })
    .returning();
  if (!trigger) throw new Error('trigger seed returned no row');
  return trigger.id;
}

/** Insert a trigger + a response for a specific client with a KNOWN rating_value. */
async function seedResponseForClient(
  db: Db,
  campaignId: string,
  clientId: string,
  ratingValue: number,
): Promise<void> {
  const triggerId = await seedTriggerForClient(db, campaignId, clientId);
  await db.insert(s.responses).values({
    triggerId,
    campaignId,
    userId: 'u',
    clientId,
    screenId: 'alpha',
    ratingValue,
    deviceOs: 'Android',
    appVersion: '1',
    shownAt: new Date(),
    respondedAt: new Date(),
  });
}

/** Insert a trigger + a response with a KNOWN chip_selected value for a campaign. */
async function seedResponseWithChip(
  db: Db,
  campaignId: string,
  ratingValue: number,
  chip: string | null,
): Promise<void> {
  const triggerId = await seedTrigger(db, campaignId);
  await db.insert(s.responses).values({
    triggerId,
    campaignId,
    userId: 'u',
    clientId: 'cl_A',
    screenId: 'alpha',
    ratingValue,
    chipSelected: chip,
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

describe('GET /v1/console/dashboard (real Postgres)', () => {
  // Fixed "now" so we can seed trigger/response rows on either side of the
  // rolling 30-day window boundary (now - 30d) deterministically.
  const NOW = new Date('2026-07-09T12:00:00.000Z');
  const clock = new FixedClock(NOW);
  const IN_WINDOW = new Date('2026-07-08T12:00:00.000Z'); // now - 1 day → inside
  const OUT_WINDOW = new Date('2026-05-30T12:00:00.000Z'); // now - 40 days → outside

  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookieHeader: string;

  /** Seed a campaign on a target with a given integration status; returns ids. */
  async function seedCampaign(
    integrationStatus: (typeof s.targetRegistry.$inferInsert)['integrationStatus'],
    overrides: Partial<typeof s.campaigns.$inferInsert> = {},
  ): Promise<string> {
    const [target] = await t.db
      .insert(s.targetRegistry)
      .values({
        name: 'Screen',
        screenId: `scr-${Math.random().toString(36).slice(2, 10)}`,
        triggerMechanism: 'action',
        integrationStatus,
      })
      .returning();
    if (!target) throw new Error('target seed returned no row');
    const [row] = await t.db
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

  /** Insert one trigger_log row at a controlled shown_at; returns its id. */
  async function seedTriggerAt(campaignId: string, shownAt: Date): Promise<string> {
    const [trigger] = await t.db
      .insert(s.triggerLog)
      .values({ campaignId, userId: 'u', clientId: 'cl_A', screenId: 'scr', shownAt })
      .returning();
    if (!trigger) throw new Error('trigger seed returned no row');
    return trigger.id;
  }

  /** Insert a trigger + a response with a known rating at a controlled respondedAt. */
  async function seedResponseAt(
    campaignId: string,
    ratingValue: number,
    respondedAt: Date,
  ): Promise<void> {
    const triggerId = await seedTriggerAt(campaignId, respondedAt);
    await t.db.insert(s.responses).values({
      triggerId,
      campaignId,
      userId: 'u',
      clientId: 'cl_A',
      screenId: 'scr',
      ratingValue,
      deviceOs: 'Android',
      appVersion: '1',
      shownAt: respondedAt,
      respondedAt,
    });
  }

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    app = await buildApp(env, { db: t.db, clock, closeDb: async () => {} });
    const signed = app.signCookie(USER_ID);
    cookieHeader = `signal_session=${signed}`;
  });
  afterEach(async () => {
    await app.close();
  });

  it('no cookie → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/console/dashboard' });
    expect(res.statusCode).toBe(401);
  });

  it('KPIs count active campaigns and only in-window triggers/scores', async () => {
    // Active campaign A on confirmed_live: 2 in-window triggers + 1 out-of-window.
    // 2 responses in-window rated 5 & 4 (both >= threshold 4) → positive_score 1.0.
    const a = await seedCampaign('confirmed_live');
    await seedTriggerAt(a, IN_WINDOW);
    await seedTriggerAt(a, IN_WINDOW);
    await seedTriggerAt(a, OUT_WINDOW); // excluded by window
    await seedResponseAt(a, 5, IN_WINDOW); // adds a 4th in-window trigger
    await seedResponseAt(a, 4, IN_WINDOW); // adds a 5th in-window trigger

    // Active campaign B on confirmed_live: 2 in-window triggers, 2 responses
    // rated 2 & 2 (both < threshold) → positive_score 0.0.
    const b = await seedCampaign('confirmed_live');
    await seedResponseAt(b, 2, IN_WINDOW);
    await seedResponseAt(b, 2, IN_WINDOW);

    // A draft campaign — NOT counted in active_campaigns.
    await seedCampaign('confirmed_live', { status: 'draft' });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/console/dashboard',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(dashboardSummarySchema.safeParse(body).success).toBe(true);

    expect(body.kpis.active_campaigns).toBe(2); // A + B (draft excluded)
    // A: 2 bare + 2 response triggers in-window = 4; B: 2 → 6 in-window; 1 out excluded.
    expect(body.kpis.total_triggers_30d).toBe(6);
    // avg of per-active-campaign scores: A=1.0, B=0.0 → mean 0.5.
    expect(body.kpis.avg_positive_score).toBeCloseTo(0.5, 10);
  });

  it('active campaigns on non-live targets appear with target_not_live', async () => {
    const notSent = await seedCampaign('not_sent');
    const toEng = await seedCampaign('sent_to_engineering');
    const live = await seedCampaign('confirmed_live');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/console/dashboard',
      headers: { cookie: cookieHeader },
    });
    const body = res.json();
    const notLive = body.attention.filter(
      (a: { reason: string }) => a.reason === 'target_not_live',
    );
    const ids = notLive.map((a: { campaign_id: string }) => a.campaign_id);
    expect(ids).toContain(notSent);
    expect(ids).toContain(toEng);
    expect(ids).not.toContain(live);
  });

  it('low response rate and low score surface as attention (can co-occur)', async () => {
    // Campaign LR: 20 in-window triggers, 2 responses → rate 0.10 < 0.15.
    // Both responses rated 5 (>= threshold) → score 1.0 (NOT low_score).
    const lr = await seedCampaign('confirmed_live');
    for (let i = 0; i < 18; i++) await seedTriggerAt(lr, IN_WINDOW);
    await seedResponseAt(lr, 5, IN_WINDOW);
    await seedResponseAt(lr, 5, IN_WINDOW);

    // Campaign LS: 4 in-window triggers all responded, all rated 2 (< threshold)
    // → rate 1.0 (fine), score 0.0 < 0.60 → low_score only.
    const ls = await seedCampaign('confirmed_live');
    for (let i = 0; i < 4; i++) await seedResponseAt(ls, 2, IN_WINDOW);

    // Campaign BOTH: 20 triggers, 2 responses rated 2 → rate 0.10 AND score 0.0.
    const both = await seedCampaign('confirmed_live');
    for (let i = 0; i < 18; i++) await seedTriggerAt(both, IN_WINDOW);
    await seedResponseAt(both, 2, IN_WINDOW);
    await seedResponseAt(both, 2, IN_WINDOW);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/console/dashboard',
      headers: { cookie: cookieHeader },
    });
    const body = res.json();
    const reasonsFor = (id: string) =>
      body.attention
        .filter((a: { campaign_id: string }) => a.campaign_id === id)
        .map((a: { reason: string }) => a.reason);

    expect(reasonsFor(lr)).toContain('low_response_rate');
    expect(reasonsFor(lr)).not.toContain('low_score');
    expect(reasonsFor(ls)).toContain('low_score');
    expect(reasonsFor(ls)).not.toContain('low_response_rate');
    expect(reasonsFor(both).sort()).toEqual(['low_response_rate', 'low_score']);
  });

  it('a healthy campaign is in the health list and absent from attention', async () => {
    // 10 in-window triggers, 5 responses (rate 0.5 >= 0.15), all rated 5
    // (score 1.0 >= 0.60), confirmed_live target → healthy.
    const healthy = await seedCampaign('confirmed_live');
    for (let i = 0; i < 5; i++) await seedTriggerAt(healthy, IN_WINDOW);
    for (let i = 0; i < 5; i++) await seedResponseAt(healthy, 5, IN_WINDOW);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/console/dashboard',
      headers: { cookie: cookieHeader },
    });
    const body = res.json();

    const row = body.campaigns.find((c: { campaign_id: string }) => c.campaign_id === healthy);
    expect(row).toBeDefined();
    expect(row.status).toBe('active');
    expect(row.integration_status).toBe('confirmed_live');
    expect(row.triggers_30d).toBe(10); // 5 bare + 5 response triggers
    expect(row.responses_30d).toBe(5);
    expect(row.response_rate).toBeCloseTo(0.5, 10);
    expect(row.positive_score).toBeCloseTo(1.0, 10);

    const inAttention = body.attention.some(
      (a: { campaign_id: string }) => a.campaign_id === healthy,
    );
    expect(inAttention).toBe(false);
  });

  it('health list includes paused, excludes draft and archived', async () => {
    const active = await seedCampaign('confirmed_live');
    const paused = await seedCampaign('confirmed_live', { status: 'paused' });
    const draft = await seedCampaign('confirmed_live', { status: 'draft' });
    const archived = await seedCampaign('confirmed_live', { status: 'archived' });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/console/dashboard',
      headers: { cookie: cookieHeader },
    });
    const ids = res.json().campaigns.map((c: { campaign_id: string }) => c.campaign_id);
    expect(ids).toContain(active);
    expect(ids).toContain(paused);
    expect(ids).not.toContain(draft);
    expect(ids).not.toContain(archived);
  });
});

describe('GET /v1/console/campaigns/:id/reasons (real Postgres)', () => {
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
      url: `/v1/console/campaigns/${UNKNOWN_ID}/reasons`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('unknown id → 404 campaign_not_found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/campaigns/${UNKNOWN_ID}/reasons`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('campaign_not_found');
  });

  it('ranks non-null chip selections desc with shares and ignores null chips', async () => {
    // chip "A" ×3, chip "B" ×1, chip null ×2 → total_chip_responses = 4.
    const id = await seedActiveCampaign(t.db);
    await seedResponseWithChip(t.db, id, 5, 'A');
    await seedResponseWithChip(t.db, id, 4, 'A');
    await seedResponseWithChip(t.db, id, 3, 'A');
    await seedResponseWithChip(t.db, id, 2, 'B');
    await seedResponseWithChip(t.db, id, 1, null);
    await seedResponseWithChip(t.db, id, 1, null);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/campaigns/${id}/reasons`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(reasonsSchema.safeParse(body).success).toBe(true);
    expect(body.campaign_id).toBe(id);
    expect(body.total_chip_responses).toBe(4);
    expect(body.chips).toEqual([
      { chip: 'A', count: 3, share: 0.75 },
      { chip: 'B', count: 1, share: 0.25 },
    ]);
  });

  it('zero chip responses → total_chip_responses=0, chips=[]', async () => {
    // Only null-chip responses → no chip aggregation.
    const id = await seedActiveCampaign(t.db);
    await seedResponseWithChip(t.db, id, 5, null);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/campaigns/${id}/reasons`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(reasonsSchema.safeParse(body).success).toBe(true);
    expect(body.total_chip_responses).toBe(0);
    expect(body.chips).toEqual([]);
  });
});

describe('GET /v1/console/campaigns/:id/clients (real Postgres)', () => {
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
      url: `/v1/console/campaigns/${UNKNOWN_ID}/clients`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('unknown id → 404 campaign_not_found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/campaigns/${UNKNOWN_ID}/clients`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('campaign_not_found');
  });

  it('splits triggers/responses per client with null-safe rates', async () => {
    // Campaign for [cl_A, cl_B], threshold 4.
    // cl_A: 4 triggers / 2 responses (ratings 5 and 1) → rate 0.5, score 0.5.
    // cl_B: 2 triggers / 0 responses → rate 0 (has triggers), score null.
    const id = await seedActiveCampaign(t.db, {
      clientIds: ['cl_A', 'cl_B'],
      positiveThreshold: 4,
    });
    // cl_A: two bare triggers + two responses (each response adds a trigger) = 4.
    await seedTriggerForClient(t.db, id, 'cl_A');
    await seedTriggerForClient(t.db, id, 'cl_A');
    await seedResponseForClient(t.db, id, 'cl_A', 5);
    await seedResponseForClient(t.db, id, 'cl_A', 1);
    // cl_B: two bare triggers, no responses.
    await seedTriggerForClient(t.db, id, 'cl_B');
    await seedTriggerForClient(t.db, id, 'cl_B');

    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/campaigns/${id}/clients`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(clientBreakdownSchema.safeParse(body).success).toBe(true);
    expect(body.campaign_id).toBe(id);
    // Order preserved from client_ids.
    expect(body.clients.map((c: { client_id: string }) => c.client_id)).toEqual(['cl_A', 'cl_B']);

    const [a, b] = body.clients;
    expect(a).toEqual({
      client_id: 'cl_A',
      triggers: 4,
      responses: 2,
      response_rate: 0.5,
      positive_score: 0.5, // one of two responses (rating 5) >= 4
    });
    // cl_B has triggers but zero responses → rate is 0 (NOT null), score null.
    expect(b.client_id).toBe('cl_B');
    expect(b.triggers).toBe(2);
    expect(b.responses).toBe(0);
    expect(b.response_rate).toBe(0);
    expect(b.positive_score).toBeNull();
  });

  it('a client with zero triggers still appears with null rate and score', async () => {
    const id = await seedActiveCampaign(t.db, {
      clientIds: ['cl_A', 'cl_ZERO'],
      positiveThreshold: 4,
    });
    await seedTriggerForClient(t.db, id, 'cl_A');

    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/campaigns/${id}/clients`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(clientBreakdownSchema.safeParse(body).success).toBe(true);

    const zero = body.clients.find((c: { client_id: string }) => c.client_id === 'cl_ZERO');
    expect(zero).toBeDefined();
    expect(zero.triggers).toBe(0);
    expect(zero.responses).toBe(0);
    expect(zero.response_rate).toBeNull(); // zero triggers → null (not 0)
    expect(zero.positive_score).toBeNull();
  });
});
