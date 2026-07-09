// apps/api/test/console-campaigns.int.test.ts
import { campaignListItemSchema, campaignSchema } from '@signal/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Clock } from '../src/clock.js';
import type { Db } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import { parseEnv } from '../src/env.js';
import { startTestDb } from './testDb.js';

const env = parseEnv({ NODE_ENV: 'test', SIGNAL_APP_KEYS: 'test-app-key' });

const USER_ID = '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

/** Fixed clock so the `updated_at` bump is deterministic (no wall-clock races). */
class FixedClock implements Clock {
  constructor(private current: Date) {}
  now() {
    return this.current;
  }
}

async function seedTarget(db: Db): Promise<string> {
  const [row] = await db
    .insert(s.targetRegistry)
    .values({
      name: 'Alpha Screen',
      screenId: 'alpha',
      triggerMechanism: 'action',
      integrationStatus: 'confirmed_live',
    })
    .returning();
  if (!row) throw new Error('target seed returned no row');
  return row.id;
}

/**
 * Seed one response for a campaign so `count(responses where campaign_id) > 0`.
 * A response references a `trigger_log` row (FK), so we insert that first with
 * the minimal valid columns.
 */
async function seedResponse(db: Db, campaignId: string): Promise<void> {
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
  await db.insert(s.responses).values({
    triggerId: trigger.id,
    campaignId,
    userId: 'u',
    clientId: 'cl_A',
    screenId: 'alpha',
    ratingValue: 5,
    deviceOs: 'Android',
    appVersion: '1',
    shownAt: new Date(),
    respondedAt: new Date(),
  });
}

describe('/v1/console/campaigns create/get/list (real Postgres)', () => {
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
      expect(body.created_by).toBe(USER_ID);
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.client_ids).toEqual([]);
      expect(body.target_id).toBeNull();
    });

    it('with client_ids in the body → they are persisted on the draft', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/console/campaigns',
        headers: { cookie: cookieHeader },
        payload: { client_ids: ['c-alpha', 'c-beta'] },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().client_ids).toEqual(['c-alpha', 'c-beta']);
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
      const targetId = await seedTarget(t.db);
      await t.db.insert(s.campaigns).values({
        targetId,
        clientIds: ['c-alpha', 'c-beta'],
        headerText: 'Rate us',
        createdBy: USER_ID,
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
      expect(body[0].client_count).toBe(2);
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
      expect(body[0].client_count).toBe(0);
    });

    it('excludes archived by default, includes them with ?include=archived', async () => {
      // one draft (created via the API), one archived directly in the DB
      await app.inject({
        method: 'POST',
        url: '/v1/console/campaigns',
        headers: { cookie: cookieHeader },
        payload: {},
      });
      await t.db.insert(s.campaigns).values({ createdBy: USER_ID, status: 'archived' });

      const def = await app.inject({
        method: 'GET',
        url: '/v1/console/campaigns',
        headers: { cookie: cookieHeader },
      });
      expect(def.statusCode).toBe(200);
      const defBody = def.json();
      expect(defBody).toHaveLength(1);
      expect(defBody.every((r: { status: string }) => r.status !== 'archived')).toBe(true);

      const withArchived = await app.inject({
        method: 'GET',
        url: '/v1/console/campaigns?include=archived',
        headers: { cookie: cookieHeader },
      });
      expect(withArchived.statusCode).toBe(200);
      const allBody = withArchived.json();
      expect(allBody).toHaveLength(2);
      expect(allBody.some((r: { status: string }) => r.status === 'archived')).toBe(true);
    });
  });
});

describe('PATCH /v1/console/campaigns/:id — update + semantic-field lock (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookieHeader: string;
  // A fixed clock set well after the DB `defaultNow()` created_at, so any patch's
  // `updated_at = clock.now()` is deterministically later than created_at.
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
    app = await buildApp(env, { db: t.db, clock, closeDb: async () => {} });
    const signed = app.signCookie(USER_ID);
    cookieHeader = `signal_session=${signed}`;
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
    const targetId = await seedTarget(t.db);
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
        client_ids: ['cl_A', 'cl_B'],
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
    expect(body.client_ids).toEqual(['cl_A', 'cl_B']);
    expect(body.target_id).toBe(targetId);
    // updated_at stamped from the injected clock, later than created_at.
    expect(new Date(body.updated_at).getTime()).toBe(PATCH_TIME.getTime());
    expect(new Date(body.updated_at).getTime()).toBeGreaterThan(
      new Date(body.created_at).getTime(),
    );

    // Persisted: re-fetch returns the same values.
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
      payload: { header_text: 'First', client_ids: ['cl_A'] },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
      payload: { header_text: 'Second' },
    });
    const body = res.json();
    expect(body.header_text).toBe('Second');
    // client_ids from the earlier patch must survive the header-only patch.
    expect(body.client_ids).toEqual(['cl_A']);
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
    const body = res.json();
    expect(body.metric_type).toBe('CSAT');
    expect(body.rating_type).toBe('star');
    expect(body.rating_scale_max).toBe(5);
    expect(body.positive_threshold).toBe(4);
  });

  it('once a response exists, a semantic field patch → 422 semantic_locked, but header_text still patches', async () => {
    const id = await createDraft();
    await seedResponse(t.db, id);

    const locked = await app.inject({
      method: 'PATCH',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
      payload: { positive_threshold: 3 },
    });
    expect(locked.statusCode).toBe(422);
    expect(locked.json().error.code).toBe('semantic_locked');

    // Non-semantic (operational) field is still editable after the lock.
    const ok = await app.inject({
      method: 'PATCH',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
      payload: { header_text: 'Updated after lock' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().header_text).toBe('Updated after lock');
  });

  it('a mixed patch (semantic + operational) with a response present → 422 semantic_locked, no partial write', async () => {
    const id = await createDraft();
    await seedResponse(t.db, id);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
      payload: { header_text: 'Should not persist', rating_scale_max: 7 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('semantic_locked');

    // The operational field in the rejected patch must NOT have been written.
    const got = await app.inject({
      method: 'GET',
      url: `/v1/console/campaigns/${id}`,
      headers: { cookie: cookieHeader },
    });
    expect(got.json().header_text).not.toBe('Should not persist');
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
