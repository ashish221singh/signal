// apps/api/test/console-campaigns.int.test.ts
import { campaignListItemSchema, campaignSchema } from '@signal/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import { parseEnv } from '../src/env.js';
import { startTestDb } from './testDb.js';

const env = parseEnv({ NODE_ENV: 'test', SIGNAL_APP_KEYS: 'test-app-key' });

const USER_ID = '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

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
