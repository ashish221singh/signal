// apps/api/test/console-reporting.int.test.ts
import {
  campaignOverviewSchema,
  dashboardSummarySchema,
  reasonsSchema,
  responseFeedSchema,
  trendSchema,
} from '@signal/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Clock } from '../src/clock.js';
import type { Db } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import { parseEnv } from '../src/env.js';
import { seedAccountWithUser, startTestDb } from './testDb.js';

/** Fixed clock so the rolling 30-day window has a deterministic "now". */
class FixedClock implements Clock {
  constructor(private current: Date) {}
  now() {
    return this.current;
  }
}

const env = parseEnv({ NODE_ENV: 'test' });

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

let eventSeq = 0;
function nextEvent(): string {
  eventSeq += 1;
  return `event_${eventSeq}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Seed an active workflow with a known positive_threshold; returns its id. */
async function seedActiveWorkflow(
  db: Db,
  accountId: string,
  overrides: Partial<typeof s.workflows.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(s.workflows)
    .values({
      accountId,
      eventName: nextEvent(),
      metricType: 'CSAT',
      ratingType: 'star',
      ratingScaleMax: 5,
      headerText: 'How was it?',
      positiveThreshold: 4,
      status: 'active',
      createdBy: 'seed',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('workflow seed returned no row');
  return row.id;
}

/** Insert one trigger_log row for a workflow; returns its id. */
async function seedTrigger(db: Db, accountId: string, workflowId: string): Promise<string> {
  const [trigger] = await db
    .insert(s.triggerLog)
    .values({ accountId, workflowId, userId: 'u', eventName: 'e', shownAt: new Date() })
    .returning();
  if (!trigger) throw new Error('trigger seed returned no row');
  return trigger.id;
}

/** Insert a trigger + a response with a KNOWN rating_value for a workflow. */
async function seedResponseWithRating(
  db: Db,
  accountId: string,
  workflowId: string,
  ratingValue: number,
): Promise<void> {
  const triggerId = await seedTrigger(db, accountId, workflowId);
  await db.insert(s.responses).values({
    accountId,
    triggerId,
    workflowId,
    userId: 'u',
    eventName: 'e',
    ratingValue,
    deviceOs: 'Android',
    appVersion: '1',
    shownAt: new Date(),
    respondedAt: new Date(),
  });
}

/** Insert a trigger + a response with a KNOWN chip_selected value for a workflow. */
async function seedResponseWithChip(
  db: Db,
  accountId: string,
  workflowId: string,
  ratingValue: number,
  chip: string | null,
): Promise<void> {
  const triggerId = await seedTrigger(db, accountId, workflowId);
  await db.insert(s.responses).values({
    accountId,
    triggerId,
    workflowId,
    userId: 'u',
    eventName: 'e',
    ratingValue,
    chipSelected: chip,
    deviceOs: 'Android',
    appVersion: '1',
    shownAt: new Date(),
    respondedAt: new Date(),
  });
}

describe('GET /v1/console/workflows/:id/overview (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookieHeader: string;
  let accountId: string;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    const seeded = await seedAccountWithUser(t.db);
    accountId = seeded.accountId;
    app = await buildApp(env, { db: t.db, closeDb: async () => {} });
    cookieHeader = `signal_session=${app.signCookie(seeded.userId)}`;
  });
  afterEach(async () => {
    await app.close();
  });

  it('without a cookie → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${UNKNOWN_ID}/overview`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('unknown id → 404 not_found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${UNKNOWN_ID}/overview`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('counts triggers/responses and computes response_rate + positive_score', async () => {
    const id = await seedActiveWorkflow(t.db, accountId, { positiveThreshold: 4 });
    await seedTrigger(t.db, accountId, id);
    await seedTrigger(t.db, accountId, id);
    await seedResponseWithRating(t.db, accountId, id, 5);
    await seedResponseWithRating(t.db, accountId, id, 4);
    await seedResponseWithRating(t.db, accountId, id, 2);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${id}/overview`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(campaignOverviewSchema.safeParse(body).success).toBe(true);
    expect(body.triggers).toBe(5);
    expect(body.responses).toBe(3);
    expect(body.response_rate).toBeCloseTo(3 / 5, 10);
    expect(body.positive_score).toBeCloseTo(2 / 3, 10);
  });

  it('zero triggers and zero responses → response_rate=null, positive_score=null', async () => {
    const id = await seedActiveWorkflow(t.db, accountId);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${id}/overview`,
      headers: { cookie: cookieHeader },
    });
    const body = res.json();
    expect(body.response_rate).toBeNull();
    expect(body.positive_score).toBeNull();
  });

  it('a workflow with a null positive_threshold → positive_score=null even with responses', async () => {
    const id = await seedActiveWorkflow(t.db, accountId, {
      status: 'draft',
      positiveThreshold: null,
    });
    await seedResponseWithRating(t.db, accountId, id, 5);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${id}/overview`,
      headers: { cookie: cookieHeader },
    });
    const body = res.json();
    expect(body.positive_score).toBeNull();
    expect(body.response_rate).toBe(1);
  });

  it("isolation: A cannot read B's workflow overview → 404", async () => {
    const b = await seedAccountWithUser(t.db, { accountName: 'B', email: 'b@example.com' });
    const bId = await seedActiveWorkflow(t.db, b.accountId);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${bId}/overview`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/console/dashboard (real Postgres)', () => {
  const NOW = new Date('2026-07-09T12:00:00.000Z');
  const clock = new FixedClock(NOW);
  const IN_WINDOW = new Date('2026-07-08T12:00:00.000Z');
  const OUT_WINDOW = new Date('2026-05-30T12:00:00.000Z');

  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookieHeader: string;
  let accountId: string;

  async function seedWorkflow(
    overrides: Partial<typeof s.workflows.$inferInsert> = {},
  ): Promise<string> {
    return seedActiveWorkflow(t.db, accountId, overrides);
  }

  async function seedTriggerAt(workflowId: string, shownAt: Date): Promise<string> {
    const [trigger] = await t.db
      .insert(s.triggerLog)
      .values({ accountId, workflowId, userId: 'u', eventName: 'e', shownAt })
      .returning();
    if (!trigger) throw new Error('trigger seed returned no row');
    return trigger.id;
  }

  async function seedResponseAt(
    workflowId: string,
    ratingValue: number,
    respondedAt: Date,
  ): Promise<void> {
    const triggerId = await seedTriggerAt(workflowId, respondedAt);
    await t.db.insert(s.responses).values({
      accountId,
      triggerId,
      workflowId,
      userId: 'u',
      eventName: 'e',
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
    const seeded = await seedAccountWithUser(t.db);
    accountId = seeded.accountId;
    app = await buildApp(env, { db: t.db, clock, closeDb: async () => {} });
    cookieHeader = `signal_session=${app.signCookie(seeded.userId)}`;
  });
  afterEach(async () => {
    await app.close();
  });

  it('no cookie → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/console/dashboard' });
    expect(res.statusCode).toBe(401);
  });

  it('KPIs count active workflows and only in-window triggers/scores', async () => {
    const a = await seedWorkflow();
    await seedTriggerAt(a, IN_WINDOW);
    await seedTriggerAt(a, IN_WINDOW);
    await seedTriggerAt(a, OUT_WINDOW);
    await seedResponseAt(a, 5, IN_WINDOW);
    await seedResponseAt(a, 4, IN_WINDOW);

    const b = await seedWorkflow();
    await seedResponseAt(b, 2, IN_WINDOW);
    await seedResponseAt(b, 2, IN_WINDOW);

    await seedWorkflow({ status: 'draft' });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/console/dashboard',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(dashboardSummarySchema.safeParse(body).success).toBe(true);
    expect(body.kpis.active_campaigns).toBe(2);
    expect(body.kpis.total_triggers_30d).toBe(6);
    expect(body.kpis.avg_positive_score).toBeCloseTo(0.5, 10);
  });

  it('integration_status is null and target_not_live never appears (B2 dropped targets)', async () => {
    await seedWorkflow();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/console/dashboard',
      headers: { cookie: cookieHeader },
    });
    const body = res.json();
    expect(
      body.campaigns.every((c: { integration_status: unknown }) => c.integration_status === null),
    ).toBe(true);
    expect(body.attention.every((a: { reason: string }) => a.reason !== 'target_not_live')).toBe(
      true,
    );
  });

  it('low response rate and low score surface as attention (can co-occur)', async () => {
    const lr = await seedWorkflow();
    for (let i = 0; i < 18; i++) await seedTriggerAt(lr, IN_WINDOW);
    await seedResponseAt(lr, 5, IN_WINDOW);
    await seedResponseAt(lr, 5, IN_WINDOW);

    const ls = await seedWorkflow();
    for (let i = 0; i < 4; i++) await seedResponseAt(ls, 2, IN_WINDOW);

    const both = await seedWorkflow();
    for (let i = 0; i < 18; i++) await seedTriggerAt(both, IN_WINDOW);
    await seedResponseAt(both, 2, IN_WINDOW);
    await seedResponseAt(both, 2, IN_WINDOW);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/console/dashboard',
      headers: { cookie: cookieHeader },
    });
    const reasonsFor = (id: string) =>
      res
        .json()
        .attention.filter((a: { campaign_id: string }) => a.campaign_id === id)
        .map((a: { reason: string }) => a.reason);

    expect(reasonsFor(lr)).toContain('low_response_rate');
    expect(reasonsFor(lr)).not.toContain('low_score');
    expect(reasonsFor(ls)).toContain('low_score');
    expect(reasonsFor(ls)).not.toContain('low_response_rate');
    expect(reasonsFor(both).sort()).toEqual(['low_response_rate', 'low_score']);
  });

  it('health list includes paused, excludes draft and archived', async () => {
    const active = await seedWorkflow();
    const paused = await seedWorkflow({ status: 'paused' });
    const draft = await seedWorkflow({ status: 'draft' });
    const archived = await seedWorkflow({ status: 'archived' });

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

  it('isolation: the dashboard only reflects the caller account', async () => {
    await seedWorkflow();
    const b = await seedAccountWithUser(t.db, { accountName: 'B', email: 'b@example.com' });
    await seedActiveWorkflow(t.db, b.accountId);
    await seedActiveWorkflow(t.db, b.accountId);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/console/dashboard',
      headers: { cookie: cookieHeader },
    });
    expect(res.json().kpis.active_campaigns).toBe(1);
  });
});

describe('GET /v1/console/workflows/:id/reasons (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookieHeader: string;
  let accountId: string;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    const seeded = await seedAccountWithUser(t.db);
    accountId = seeded.accountId;
    app = await buildApp(env, { db: t.db, closeDb: async () => {} });
    cookieHeader = `signal_session=${app.signCookie(seeded.userId)}`;
  });
  afterEach(async () => {
    await app.close();
  });

  it('unknown id → 404 campaign_not_found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${UNKNOWN_ID}/reasons`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('campaign_not_found');
  });

  it('ranks non-null chip selections desc with shares and ignores null chips', async () => {
    const id = await seedActiveWorkflow(t.db, accountId);
    await seedResponseWithChip(t.db, accountId, id, 5, 'A');
    await seedResponseWithChip(t.db, accountId, id, 4, 'A');
    await seedResponseWithChip(t.db, accountId, id, 3, 'A');
    await seedResponseWithChip(t.db, accountId, id, 2, 'B');
    await seedResponseWithChip(t.db, accountId, id, 1, null);
    await seedResponseWithChip(t.db, accountId, id, 1, null);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${id}/reasons`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(reasonsSchema.safeParse(body).success).toBe(true);
    expect(body.total_chip_responses).toBe(4);
    expect(body.chips).toEqual([
      { chip: 'A', count: 3, share: 0.75 },
      { chip: 'B', count: 1, share: 0.25 },
    ]);
  });
});

describe('GET /v1/console/workflows/:id/responses (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookieHeader: string;
  let accountId: string;

  async function seedResponseAt(
    db: Db,
    workflowId: string,
    ratingValue: number,
    respondedAt: Date,
    extra: Partial<typeof s.responses.$inferInsert> = {},
  ): Promise<string> {
    const triggerId = await seedTrigger(db, accountId, workflowId);
    const [row] = await db
      .insert(s.responses)
      .values({
        accountId,
        triggerId,
        workflowId,
        userId: 'u',
        eventName: 'e',
        ratingValue,
        deviceOs: 'Android',
        appVersion: '1',
        shownAt: respondedAt,
        respondedAt,
        ...extra,
      })
      .returning();
    if (!row) throw new Error('response seed returned no row');
    return row.id;
  }

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    const seeded = await seedAccountWithUser(t.db);
    accountId = seeded.accountId;
    app = await buildApp(env, { db: t.db, closeDb: async () => {} });
    cookieHeader = `signal_session=${app.signCookie(seeded.userId)}`;
  });
  afterEach(async () => {
    await app.close();
  });

  it('unknown id → 404 campaign_not_found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${UNKNOWN_ID}/responses`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('campaign_not_found');
  });

  it('a bad range (min_rating>5) → 422 invalid_query', async () => {
    const id = await seedActiveWorkflow(t.db, accountId);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${id}/responses?min_rating=9`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_query');
  });

  it('returns all items newest-first with next_cursor null', async () => {
    const id = await seedActiveWorkflow(t.db, accountId);
    const base = new Date('2026-07-01T00:00:00.000Z').getTime();
    for (let r = 1; r <= 5; r++) {
      await seedResponseAt(t.db, id, r, new Date(base + r * 60_000));
    }
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${id}/responses`,
      headers: { cookie: cookieHeader },
    });
    const body = res.json();
    expect(responseFeedSchema.safeParse(body).success).toBe(true);
    expect(body.next_cursor).toBeNull();
    expect(body.items.map((i: { rating_value: number }) => i.rating_value)).toEqual([
      5, 4, 3, 2, 1,
    ]);
  });

  it('paginates via cursor with no overlap and continued ordering', async () => {
    const id = await seedActiveWorkflow(t.db, accountId);
    const base = new Date('2026-07-01T00:00:00.000Z').getTime();
    for (let r = 1; r <= 5; r++) {
      await seedResponseAt(t.db, id, r, new Date(base + r * 60_000));
    }
    const first = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${id}/responses?limit=2`,
      headers: { cookie: cookieHeader },
    });
    const page1 = first.json();
    expect(page1.items.map((i: { rating_value: number }) => i.rating_value)).toEqual([5, 4]);
    expect(page1.next_cursor).not.toBeNull();

    const second = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${id}/responses?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`,
      headers: { cookie: cookieHeader },
    });
    const page2 = second.json();
    expect(page2.items.map((i: { rating_value: number }) => i.rating_value)).toEqual([3, 2]);
  });

  it('surfaces chip/other/location fields on an item', async () => {
    const id = await seedActiveWorkflow(t.db, accountId);
    await seedResponseAt(t.db, id, 3, new Date('2026-07-01T00:00:00.000Z'), {
      chipSelected: 'slow',
      otherText: 'it was laggy',
      otherImageUrl: 'https://cdn.example/x.jpg',
      location: { lat: 12.9, lng: 77.6, state: 'KA', country: 'IN' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${id}/responses`,
      headers: { cookie: cookieHeader },
    });
    const body = res.json();
    expect(responseFeedSchema.safeParse(body).success).toBe(true);
    const [item] = body.items;
    expect(item.chip_selected).toBe('slow');
    expect(item.other_text).toBe('it was laggy');
    expect(item.location).toEqual({ lat: 12.9, lng: 77.6, state: 'KA', country: 'IN' });
  });
});

describe('GET /v1/console/workflows/:id/trend (real Postgres)', () => {
  const NOW = new Date('2026-07-09T12:00:00.000Z');
  const clock = new FixedClock(NOW);

  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookieHeader: string;
  let accountId: string;

  async function seedResponseAt(
    workflowId: string,
    ratingValue: number,
    respondedAt: Date,
  ): Promise<void> {
    const triggerId = await seedTrigger(t.db, accountId, workflowId);
    await t.db.insert(s.responses).values({
      accountId,
      triggerId,
      workflowId,
      userId: 'u',
      eventName: 'e',
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
    const seeded = await seedAccountWithUser(t.db);
    accountId = seeded.accountId;
    app = await buildApp(env, { db: t.db, clock, closeDb: async () => {} });
    cookieHeader = `signal_session=${app.signCookie(seeded.userId)}`;
  });
  afterEach(async () => {
    await app.close();
  });

  it('one point per UTC day with per-day responses count and positive_score', async () => {
    const id = await seedActiveWorkflow(t.db, accountId, { positiveThreshold: 4 });
    await seedResponseAt(id, 5, new Date('2026-07-01T02:00:00.000Z'));
    await seedResponseAt(id, 4, new Date('2026-07-01T20:00:00.000Z'));
    await seedResponseAt(id, 5, new Date('2026-07-03T01:00:00.000Z'));
    await seedResponseAt(id, 2, new Date('2026-07-03T10:00:00.000Z'));
    await seedResponseAt(id, 3, new Date('2026-07-03T23:00:00.000Z'));
    await seedResponseAt(id, 1, new Date('2026-07-05T12:00:00.000Z'));

    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${id}/trend`,
      headers: { cookie: cookieHeader },
    });
    const body = res.json();
    expect(trendSchema.safeParse(body).success).toBe(true);
    expect(body.points.map((p: { date: string }) => p.date)).toEqual([
      '2026-07-01',
      '2026-07-03',
      '2026-07-05',
    ]);
    const [a, b, c] = body.points;
    expect(a.responses).toBe(2);
    expect(a.positive_score).toBeCloseTo(1.0, 10);
    expect(b.responses).toBe(3);
    expect(b.positive_score).toBeCloseTo(1 / 3, 10);
    expect(c.responses).toBe(1);
    expect(c.positive_score).toBeCloseTo(0.0, 10);
  });

  it('out-of-window responses excluded', async () => {
    const id = await seedActiveWorkflow(t.db, accountId, { positiveThreshold: 4 });
    await seedResponseAt(id, 2, new Date('2026-07-08T04:00:00.000Z'));
    await seedResponseAt(id, 1, new Date('2026-07-08T18:00:00.000Z'));
    await seedResponseAt(id, 5, new Date('2026-05-30T12:00:00.000Z'));

    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${id}/trend`,
      headers: { cookie: cookieHeader },
    });
    const body = res.json();
    expect(body.points).toHaveLength(1);
    expect(body.points[0].date).toBe('2026-07-08');
    expect(body.points[0].responses).toBe(2);
    expect(body.points[0].positive_score).toBe(0);
  });
});
