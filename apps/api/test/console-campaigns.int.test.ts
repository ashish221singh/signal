// apps/api/test/console-campaigns.int.test.ts
import { campaignListItemSchema, campaignSchema } from '@signal/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Clock } from '../src/clock.js';
import type { Db } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import { parseEnv } from '../src/env.js';
import { seedAccountWithUser, seedApiKey, startTestDb } from './testDb.js';

const env = parseEnv({ NODE_ENV: 'test' });

const SDK_KEY = 'pk_test_campaignsxxxxxxxxxxxx';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

/** Fixed clock so the `updated_at` bump is deterministic (no wall-clock races). */
class FixedClock implements Clock {
  constructor(private current: Date) {}
  now() {
    return this.current;
  }
}

async function seedTarget(
  db: Db,
  accountId: string,
  overrides: Partial<typeof s.targetRegistry.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(s.targetRegistry)
    .values({
      accountId,
      name: 'Alpha Screen',
      screenId: 'alpha',
      triggerMechanism: 'action',
      integrationStatus: 'confirmed_live',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('target seed returned no row');
  return row.id;
}

/** Seed one response for a campaign so `count(responses where campaign_id) > 0`. */
async function seedResponse(db: Db, accountId: string, campaignId: string): Promise<void> {
  const [trigger] = await db
    .insert(s.triggerLog)
    .values({ accountId, campaignId, userId: 'u', screenId: 'alpha', shownAt: new Date() })
    .returning();
  if (!trigger) throw new Error('trigger seed returned no row');
  await db.insert(s.responses).values({
    accountId,
    triggerId: trigger.id,
    campaignId,
    userId: 'u',
    screenId: 'alpha',
    ratingValue: 5,
    deviceOs: 'Android',
    appVersion: '1',
    shownAt: new Date(),
    respondedAt: new Date(),
  });
}

/** The complete set of builder fields required to publish (mirrors the DB CHECK). */
function completePayload(targetId: string) {
  return {
    target_id: targetId,
    metric_type: 'CSAT' as const,
    rating_type: 'star' as const,
    rating_scale_max: 5,
    header_text: 'How was your delivery?',
    positive_threshold: 4,
    ask_frequency: 'after_7_days' as const,
  };
}

describe('/v1/console/campaigns create/get/list (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookieHeader: string;
  let accountId: string;
  let userId: string;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    ({ accountId, userId } = await seedAccountWithUser(t.db));
    app = await buildApp(env, { db: t.db, closeDb: async () => {} });
    cookieHeader = `signal_session=${app.signCookie(userId)}`;
  });
  afterEach(async () => {
    await app.close();
  });

  describe('POST /v1/console/campaigns', () => {
    it('without a cookie → 401', async () => {
      const res = await app.inject({ method: 'POST', url: '/v1/console/campaigns', payload: {} });
      expect(res.statusCode).toBe(401);
    });

    it('with a cookie and empty body → 201, valid draft owned by the session user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/console/campaigns',
        headers: { cookie: cookieHeader },
        payload: {},
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(campaignSchema.safeParse(body).success).toBe(true);
      expect(body.status).toBe('draft');
      expect(body.created_by).toBe(userId);
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.target_id).toBeNull();
    });
  });

  describe('GET /v1/console/campaigns/:id', () => {
    it('without a cookie → 401', async () => {
      const res = await app.inject({ method: 'GET', url: `/v1/console/campaigns/${UNKNOWN_ID}` });
      expect(res.statusCode).toBe(401);
    });

    it('returns the created draft', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/console/campaigns',
        headers: { cookie: cookieHeader },
        payload: {},
      });
      const id = created.json().id;
      const res = await app.inject({
        method: 'GET',
        url: `/v1/console/campaigns/${id}`,
        headers: { cookie: cookieHeader },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(campaignSchema.safeParse(body).success).toBe(true);
      expect(body.id).toBe(id);
    });

    it('unknown id → 404 not_found', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/console/campaigns/${UNKNOWN_ID}`,
        headers: { cookie: cookieHeader },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });
  });

  describe('GET /v1/console/campaigns', () => {
    it('without a cookie → 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/console/campaigns' });
      expect(res.statusCode).toBe(401);
    });

    it('lists drafts as campaignListItem shapes, joining screen_id from the target', async () => {
      const targetId = await seedTarget(t.db, accountId);
      await t.db.insert(s.campaigns).values({
        accountId,
        targetId,
        headerText: 'Rate us',
        createdBy: userId,
      });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/console/campaigns',
        headers: { cookie: cookieHeader },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      for (const row of body) {
        expect(campaignListItemSchema.safeParse(row).success).toBe(true);
      }
      expect(body[0].screen_id).toBe('alpha');
      expect(body[0].header_text).toBe('Rate us');
    });

    it('a draft with no target has a null screen_id', async () => {
      await app.inject({
        method: 'POST',
        url: '/v1/console/campaigns',
        headers: { cookie: cookieHeader },
        payload: {},
      });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/console/campaigns',
        headers: { cookie: cookieHeader },
      });
      const body = res.json();
      expect(body).toHaveLength(1);
      expect(body[0].screen_id).toBeNull();
    });

    it('excludes archived by default, includes them with ?include=archived', async () => {
      await app.inject({
        method: 'POST',
        url: '/v1/console/campaigns',
        headers: { cookie: cookieHeader },
        payload: {},
      });
      await t.db.insert(s.campaigns).values({ accountId, createdBy: userId, status: 'archived' });

      const def = await app.inject({
        method: 'GET',
        url: '/v1/console/campaigns',
        headers: { cookie: cookieHeader },
      });
      expect(def.statusCode).toBe(200);
      expect(def.json()).toHaveLength(1);
      expect(def.json().every((r: { status: string }) => r.status !== 'archived')).toBe(true);

      const withArchived = await app.inject({
        method: 'GET',
        url: '/v1/console/campaigns?include=archived',
        headers: { cookie: cookieHeader },
      });
      expect(withArchived.json()).toHaveLength(2);
      expect(withArchived.json().some((r: { status: string }) => r.status === 'archived')).toBe(
        true,
      );
    });
  });
});

describe('PATCH /v1/console/campaigns/:id — update + semantic-field lock (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookieHeader: string;
  let accountId: string;
  let userId: string;
  const PATCH_TIME = new Date('2030-01-01T00:00:00.000Z');
  const clock = new FixedClock(PATCH_TIME);

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    ({ accountId, userId } = await seedAccountWithUser(t.db));
    app = await buildApp(env, { db: t.db, clock, closeDb: async () => {} });
    cookieHeader = `signal_session=${app.signCookie(userId)}`;
  });
  afterEach(async () => {
    await app.close();
  });

  async function createDraft(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/console/campaigns',
      headers: { cookie: cookieHeader },
      payload: {},
    });
    return res.json().id;
  }

  it('updates operational fields on a draft → 200, persisted, updated_at bumped', async () => {
    const targetId = await seedTarget(t.db, accountId);
    const id = await createDraft();

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
      payload: {
        header_text: 'How was your experience?',
        chips_on_negative: ['Slow', 'Confusing'],
        ask_frequency: 'after_30_days',
        min_tenure_days: 14,
        target_id: targetId,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(campaignSchema.safeParse(body).success).toBe(true);
    expect(body.header_text).toBe('How was your experience?');
    expect(body.chips_on_negative).toEqual(['Slow', 'Confusing']);
    expect(body.ask_frequency).toBe('after_30_days');
    expect(body.min_tenure_days).toBe(14);
    expect(body.target_id).toBe(targetId);
    expect(new Date(body.updated_at).getTime()).toBe(PATCH_TIME.getTime());
    expect(new Date(body.updated_at).getTime()).toBeGreaterThan(
      new Date(body.created_at).getTime(),
    );

    const got = await app.inject({
      method: 'GET',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
    });
    expect(got.json().header_text).toBe('How was your experience?');
    expect(got.json().min_tenure_days).toBe(14);
  });

  it('a partial patch does not clobber unset columns', async () => {
    const id = await createDraft();
    await app.inject({
      method: 'PATCH',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
      payload: { header_text: 'First', chips_on_negative: ['Slow'] },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
      payload: { header_text: 'Second' },
    });
    const body = res.json();
    expect(body.header_text).toBe('Second');
    expect(body.chips_on_negative).toEqual(['Slow']);
  });

  it('semantic fields are patchable while the campaign has zero responses → 200', async () => {
    const id = await createDraft();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
      payload: {
        metric_type: 'CSAT',
        rating_type: 'star',
        rating_scale_max: 5,
        positive_threshold: 4,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().metric_type).toBe('CSAT');
  });

  it('once a response exists, a semantic field patch → 422 semantic_locked, but header_text still patches', async () => {
    const id = await createDraft();
    await seedResponse(t.db, accountId, id);

    const locked = await app.inject({
      method: 'PATCH',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
      payload: { positive_threshold: 3 },
    });
    expect(locked.statusCode).toBe(422);
    expect(locked.json().error.code).toBe('semantic_locked');

    const ok = await app.inject({
      method: 'PATCH',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
      payload: { header_text: 'Updated after lock' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().header_text).toBe('Updated after lock');
  });

  it('invalid body → 422 invalid_body', async () => {
    const id = await createDraft();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
      payload: { metric_type: 'NPS' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_body');
  });

  it('unknown id → 404 not_found', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/console/campaigns/${UNKNOWN_ID}`,
      headers: { cookie: cookieHeader },
      payload: { header_text: 'Nope' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});

describe('POST /v1/console/campaigns/:id/publish — completeness + overlap 409 (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookieHeader: string;
  let accountId: string;
  let userId: string;
  const clock = new FixedClock(new Date('2030-01-01T00:00:00.000Z'));

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    ({ accountId, userId } = await seedAccountWithUser(t.db));
    await seedApiKey(t.db, accountId, SDK_KEY);
    app = await buildApp(env, { db: t.db, clock, closeDb: async () => {} });
    cookieHeader = `signal_session=${app.signCookie(userId)}`;
  });
  afterEach(async () => {
    await app.close();
  });

  async function draftWith(patch: Record<string, unknown>): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/console/campaigns',
      headers: { cookie: cookieHeader },
      payload: {},
    });
    const id = created.json().id as string;
    await app.inject({
      method: 'PATCH',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
      payload: patch,
    });
    return id;
  }

  async function getCampaign(id: string) {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
    });
    return res.json();
  }

  it('publish requires a cookie → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${UNKNOWN_ID}/publish`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('unknown id → 404 not_found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${UNKNOWN_ID}/publish`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  // CROSS-MILESTONE: a Console-published campaign fires through the SDK
  // eligibility engine after the campaign cache is refreshed, authenticated by
  // the account's publishable key.
  it('scenario 1: a fully-specified draft publishes → 200 active AND appears via /v1/sdk/eligibility', async () => {
    const targetId = await seedTarget(t.db, accountId, { screenId: 'order_completion' });
    const id = await draftWith(completePayload(targetId));

    const pub = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${id}/publish`,
      headers: { cookie: cookieHeader },
    });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().status).toBe('active');

    await app.campaignCache.refresh();

    const elig = await app.inject({
      method: 'GET',
      url: '/v1/sdk/eligibility',
      headers: { 'x-signal-app-key': SDK_KEY },
      query: {
        screen_id: 'order_completion',
        user_id: 'fresh-user-scenario-1',
        rep_tenure_days: '365',
      },
    });
    expect(elig.statusCode).toBe(200);
    const cfg = elig.json();
    expect(cfg.header).toBe('How was your delivery?');
    expect(cfg.campaign_id).toBe(id);
    expect(cfg.trigger_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('scenario 2: publishing a draft missing header_text → 422 incomplete listing header_text; stays draft', async () => {
    const targetId = await seedTarget(t.db, accountId);
    const { header_text: _omit, ...noHeader } = completePayload(targetId);
    const id = await draftWith(noHeader);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${id}/publish`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('incomplete');
    expect(res.json().missing).toContain('header_text');
    expect((await getCampaign(id)).status).toBe('draft');
  });

  it('scenario 2b: an empty draft → 422 incomplete listing every required field', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/console/campaigns',
      headers: { cookie: cookieHeader },
      payload: {},
    });
    const id = created.json().id;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${id}/publish`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('incomplete');
    expect(new Set(res.json().missing)).toEqual(
      new Set([
        'target_id',
        'metric_type',
        'rating_type',
        'rating_scale_max',
        'header_text',
        'positive_threshold',
      ]),
    );
    expect((await getCampaign(id)).status).toBe('draft');
  });

  // Overlap 409: one active campaign per (account, target) — B1 rule (no clients).
  it('scenario 3: publishing over an active campaign on the same target → 409 overlap; stays draft', async () => {
    const targetId = await seedTarget(t.db, accountId);
    const idA = await draftWith(completePayload(targetId));
    const pubA = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${idA}/publish`,
      headers: { cookie: cookieHeader },
    });
    expect(pubA.statusCode).toBe(200);

    const idB = await draftWith(completePayload(targetId));
    const pubB = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${idB}/publish`,
      headers: { cookie: cookieHeader },
    });
    expect(pubB.statusCode).toBe(409);
    const body = pubB.json();
    expect(body.error.code).toBe('overlap');
    expect(body.conflict.id).toBe(idA);
    expect(body.conflict.header).toBe('How was your delivery?');
    expect((await getCampaign(idB)).status).toBe('draft');
  });

  it('scenario 4a: overlap ignores active campaigns on a DIFFERENT target → 200', async () => {
    const targetA = await seedTarget(t.db, accountId, { screenId: 'alpha' });
    const targetB = await seedTarget(t.db, accountId, { screenId: 'beta' });
    const idA = await draftWith(completePayload(targetA));
    await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${idA}/publish`,
      headers: { cookie: cookieHeader },
    });
    const idB = await draftWith(completePayload(targetB));
    const pubB = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${idB}/publish`,
      headers: { cookie: cookieHeader },
    });
    expect(pubB.statusCode).toBe(200);
    expect(pubB.json().status).toBe('active');
  });

  it('scenario 4b: overlap ignores draft/paused/archived same-target campaigns → 200', async () => {
    const targetId = await seedTarget(t.db, accountId);
    await t.db.insert(s.campaigns).values({
      accountId,
      targetId,
      metricType: 'CSAT',
      ratingType: 'star',
      ratingScaleMax: 5,
      headerText: 'Paused one',
      positiveThreshold: 4,
      status: 'paused',
      createdBy: userId,
    });
    await t.db.insert(s.campaigns).values({
      accountId,
      targetId,
      headerText: 'Archived one',
      status: 'archived',
      createdBy: userId,
    });
    const id = await draftWith(completePayload(targetId));
    const res = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${id}/publish`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('active');
  });

  it('scenario 5: a complete draft on a not_sent target publishes → 200 active (M2-D7)', async () => {
    const targetId = await seedTarget(t.db, accountId, {
      screenId: 'not_sent_screen',
      integrationStatus: 'not_sent',
    });
    const id = await draftWith(completePayload(targetId));
    const res = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${id}/publish`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('active');
  });
});

describe('campaign lifecycle: pause / resume / archive / hard-delete (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookieHeader: string;
  let accountId: string;
  let userId: string;
  const LIFECYCLE_TIME = new Date('2030-06-01T00:00:00.000Z');
  const clock = new FixedClock(LIFECYCLE_TIME);

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    ({ accountId, userId } = await seedAccountWithUser(t.db));
    await seedApiKey(t.db, accountId, SDK_KEY);
    app = await buildApp(env, { db: t.db, clock, closeDb: async () => {} });
    cookieHeader = `signal_session=${app.signCookie(userId)}`;
  });
  afterEach(async () => {
    await app.close();
  });

  async function publishActive(targetId: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/console/campaigns',
      headers: { cookie: cookieHeader },
      payload: {},
    });
    const id = created.json().id as string;
    await app.inject({
      method: 'PATCH',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
      payload: completePayload(targetId),
    });
    const pub = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${id}/publish`,
      headers: { cookie: cookieHeader },
    });
    expect(pub.statusCode).toBe(200);
    return id;
  }

  async function getCampaign(id: string) {
    return app.inject({
      method: 'GET',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
    });
  }

  async function eligible(screenId: string, userIdParam: string): Promise<boolean> {
    await app.campaignCache.refresh();
    const elig = await app.inject({
      method: 'GET',
      url: '/v1/sdk/eligibility',
      headers: { 'x-signal-app-key': SDK_KEY },
      query: { screen_id: screenId, user_id: userIdParam, rep_tenure_days: '365' },
    });
    return elig.statusCode === 200;
  }

  it('scenario 1: POST /:id/pause on active → 200 paused; no longer in the SDK cache', async () => {
    const targetId = await seedTarget(t.db, accountId, { screenId: 'order_completion' });
    const id = await publishActive(targetId);
    expect(await eligible('order_completion', 'fresh-user-pause-pre')).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${id}/pause`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('paused');
    expect(new Date(res.json().updated_at).getTime()).toBe(LIFECYCLE_TIME.getTime());

    expect(await eligible('order_completion', 'fresh-user-pause-post')).toBe(false);
  });

  it('pausing a draft (not active) → 409 invalid_state', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/console/campaigns',
      headers: { cookie: cookieHeader },
      payload: {},
    });
    const id = created.json().id as string;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${id}/pause`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('invalid_state');
  });

  it('pause unknown id → 404 not_found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${UNKNOWN_ID}/pause`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(404);
  });

  it('scenario 2: resume with no clash → 200 active; reappears in the SDK cache', async () => {
    const targetId = await seedTarget(t.db, accountId, { screenId: 'order_completion' });
    const id = await publishActive(targetId);
    await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${id}/pause`,
      headers: { cookie: cookieHeader },
    });
    expect(await eligible('order_completion', 'fresh-user-resume-pre')).toBe(false);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${id}/resume`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('active');
    expect(await eligible('order_completion', 'fresh-user-resume-post')).toBe(true);
  });

  it('scenario 2b: resume re-runs overlap — a clash that appeared while paused → 409 overlap; stays paused', async () => {
    const targetId = await seedTarget(t.db, accountId, { screenId: 'order_completion' });
    const idA = await publishActive(targetId);
    await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${idA}/pause`,
      headers: { cookie: cookieHeader },
    });
    const idB = await publishActive(targetId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${idA}/resume`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('overlap');
    expect(res.json().conflict.id).toBe(idB);
    expect((await getCampaign(idA)).json().status).toBe('paused');
  });

  it('resuming a non-paused (active) campaign → 409 invalid_state', async () => {
    const targetId = await seedTarget(t.db, accountId);
    const id = await publishActive(targetId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${id}/resume`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('invalid_state');
  });

  it('scenario 3: POST /:id/archive → 200 archived; excluded from default list and SDK cache', async () => {
    const targetId = await seedTarget(t.db, accountId, { screenId: 'order_completion' });
    const id = await publishActive(targetId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/console/campaigns/${id}/archive`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('archived');

    const list = await app.inject({
      method: 'GET',
      url: '/v1/console/campaigns',
      headers: { cookie: cookieHeader },
    });
    expect(list.json().some((r: { id: string }) => r.id === id)).toBe(false);
    expect(await eligible('order_completion', 'fresh-user-archive')).toBe(false);
  });

  it('scenario 4: DELETE /:id on a draft with zero triggers/responses → 204, row gone', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/console/campaigns',
      headers: { cookie: cookieHeader },
      payload: {},
    });
    const id = created.json().id as string;

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
    });
    expect(del.statusCode).toBe(204);
    expect((await getCampaign(id)).statusCode).toBe(404);
  });

  it('scenario 5: DELETE on a campaign with trigger/response rows → 409 has_history; row survives', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/console/campaigns',
      headers: { cookie: cookieHeader },
      payload: {},
    });
    const id = created.json().id as string;
    await seedResponse(t.db, accountId, id);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
    });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe('has_history');
    expect((await getCampaign(id)).statusCode).toBe(200);
  });

  it('scenario 5b: DELETE on an ACTIVE campaign with zero history → 409 has_history', async () => {
    const targetId = await seedTarget(t.db, accountId);
    const id = await publishActive(targetId);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
    });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe('has_history');
    expect((await getCampaign(id)).statusCode).toBe(200);
  });
});

describe('console campaign isolation: account A cannot touch account B (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let a: { accountId: string; userId: string };
  let b: { accountId: string; userId: string };
  let cookieA: string;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    a = await seedAccountWithUser(t.db, { accountName: 'A', email: 'a@example.com' });
    b = await seedAccountWithUser(t.db, { accountName: 'B', email: 'b@example.com' });
    app = await buildApp(env, { db: t.db, closeDb: async () => {} });
    cookieA = `signal_session=${app.signCookie(a.userId)}`;
  });
  afterEach(async () => {
    await app.close();
  });

  it("A cannot read, list, or mutate B's campaign", async () => {
    // B owns a draft (seeded directly).
    const [bCampaign] = await t.db
      .insert(s.campaigns)
      .values({ accountId: b.accountId, createdBy: b.userId, headerText: 'B only' })
      .returning();
    const bid = bCampaign!.id;

    // A's list is empty.
    const list = await app.inject({
      method: 'GET',
      url: '/v1/console/campaigns',
      headers: { cookie: cookieA },
    });
    expect(list.json()).toHaveLength(0);

    // A cannot GET B's campaign.
    const get = await app.inject({
      method: 'GET',
      url: `/v1/console/campaigns/${bid}`,
      headers: { cookie: cookieA },
    });
    expect(get.statusCode).toBe(404);

    // A cannot PATCH B's campaign.
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/console/campaigns/${bid}`,
      headers: { cookie: cookieA },
      payload: { header_text: 'hacked' },
    });
    expect(patch.statusCode).toBe(404);

    // A cannot DELETE B's campaign; it survives.
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/console/campaigns/${bid}`,
      headers: { cookie: cookieA },
    });
    expect(del.statusCode).toBe(404);
    const [still] = await t.db.select().from(s.campaigns).where(eq(s.campaigns.id, bid));
    expect(still!.headerText).toBe('B only');
  });
});
