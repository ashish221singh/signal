// apps/api/test/routes.int.test.ts
import { eligibilityConfigSchema } from '@signal/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import { parseEnv } from '../src/env.js';
import { seedAccount, seedApiKey, startTestDb } from './testDb.js';

const APP_KEY = 'pk_test_sdkroutesxxxxxxxxxxxx';
const env = parseEnv({ NODE_ENV: 'test' });

async function seedStarCampaign(db: Db, accountId: string) {
  const [target] = await db
    .insert(s.targetRegistry)
    .values({
      accountId,
      name: 'Order Completion',
      screenId: 'order_completion',
      triggerMechanism: 'action',
      integrationStatus: 'confirmed_live',
    })
    .onConflictDoNothing()
    .returning();
  await db.insert(s.campaigns).values({
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
  });
}

async function seedEmojiCampaign(db: Db, accountId: string) {
  const [target] = await db
    .insert(s.targetRegistry)
    .values({
      accountId,
      name: 'New Customer Creation',
      screenId: 'new_customer_creation',
      triggerMechanism: 'action',
      integrationStatus: 'confirmed_live',
    })
    .onConflictDoNothing()
    .returning();
  await db.insert(s.campaigns).values({
    accountId,
    targetId: target!.id,
    metricType: 'CSAT',
    ratingType: 'emoji',
    ratingScaleMax: 3,
    headerText: 'Emoji?',
    positiveThreshold: 3,
    chipsOnNegative: ['Bad'],
    askFrequency: 'after_7_days',
    status: 'active',
    createdBy: 'test',
  });
}

const AUTH = { 'x-signal-app-key': APP_KEY };

describe('/v1/sdk routes (real Postgres)', () => {
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
    await seedApiKey(t.db, accountId, APP_KEY);
  });

  describe('GET /health', () => {
    let app: Awaited<ReturnType<typeof buildApp>>;
    beforeEach(async () => {
      app = await buildApp(env, { db: t.db, closeDb: async () => {} });
    });
    afterEach(async () => {
      await app.close();
    });

    it('returns 200 with the health contract', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'ok' });
    });

    it('returns 404 for unknown routes', async () => {
      const res = await app.inject({ method: 'GET', url: '/nope' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('eligibility', () => {
    it('scenario 1+2: eligible → 200 then suppressed → 204', async () => {
      await seedStarCampaign(t.db, accountId);
      const app = await buildApp(env, { db: t.db, closeDb: async () => {} });
      try {
        const first = await app.inject({
          method: 'GET',
          url: '/v1/sdk/eligibility',
          query: { screen_id: 'order_completion', user_id: 'u_1' },
          headers: AUTH,
        });
        expect(first.statusCode).toBe(200);
        expect(eligibilityConfigSchema.safeParse(first.json()).success).toBe(true);

        const second = await app.inject({
          method: 'GET',
          url: '/v1/sdk/eligibility',
          query: { screen_id: 'order_completion', user_id: 'u_1' },
          headers: AUTH,
        });
        expect(second.statusCode).toBe(204);
        expect(second.body).toBe('');
      } finally {
        await app.close();
      }
    });

    it('scenario 3: missing screen_id → 422 with error body', async () => {
      const app = await buildApp(env, { db: t.db, closeDb: async () => {} });
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/v1/sdk/eligibility',
          query: { user_id: 'u_1' },
          headers: AUTH,
        });
        expect(res.statusCode).toBe(422);
        const body = res.json();
        expect(body.error).toBeDefined();
        expect(typeof body.error.code).toBe('string');
        expect(typeof body.error.message).toBe('string');
      } finally {
        await app.close();
      }
    });
  });

  describe('scenario 4: auth on all three routes', () => {
    it('rejects no key and wrong key with 401', async () => {
      const app = await buildApp(env, { db: t.db, closeDb: async () => {} });
      try {
        const routes = [
          { method: 'GET' as const, url: '/v1/sdk/eligibility' },
          { method: 'POST' as const, url: '/v1/sdk/response' },
          { method: 'POST' as const, url: '/v1/sdk/dismiss' },
        ];
        for (const r of routes) {
          const noKey = await app.inject({ method: r.method, url: r.url });
          expect(noKey.statusCode).toBe(401);
          const wrongKey = await app.inject({
            method: r.method,
            url: r.url,
            headers: { 'x-signal-app-key': 'nope' },
          });
          expect(wrongKey.statusCode).toBe(401);
        }
      } finally {
        await app.close();
      }
    });
  });

  describe('internal refresh-cache hook (Task 18)', () => {
    it('204 with the app key, 401 without', async () => {
      const app = await buildApp(env, { db: t.db, closeDb: async () => {} });
      try {
        const ok = await app.inject({
          method: 'POST',
          url: '/v1/sdk/internal/refresh-cache',
          headers: AUTH,
        });
        expect(ok.statusCode).toBe(204);
        expect(ok.body).toBe('');

        const noKey = await app.inject({
          method: 'POST',
          url: '/v1/sdk/internal/refresh-cache',
        });
        expect(noKey.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  });

  describe('scenario 5+6: response', () => {
    it('valid → 204, replay → 204, exactly one row', async () => {
      await seedStarCampaign(t.db, accountId);
      const app = await buildApp(env, { db: t.db, closeDb: async () => {} });
      try {
        const elig = await app.inject({
          method: 'GET',
          url: '/v1/sdk/eligibility',
          query: { screen_id: 'order_completion', user_id: 'u_1' },
          headers: AUTH,
        });
        const triggerId = elig.json().trigger_id as string;

        const body = {
          trigger_id: triggerId,
          rating_value: 5,
          device_os: 'android 14',
          app_version: '1.0.0',
          shown_at: '2026-07-09T10:00:00Z',
          responded_at: '2026-07-09T10:00:05Z',
        };

        const first = await app.inject({
          method: 'POST',
          url: '/v1/sdk/response',
          headers: AUTH,
          payload: body,
        });
        expect(first.statusCode).toBe(204);

        const replay = await app.inject({
          method: 'POST',
          url: '/v1/sdk/response',
          headers: AUTH,
          payload: body,
        });
        expect(replay.statusCode).toBe(204);

        const rows = await t.db
          .select()
          .from(s.responses)
          .where(eq(s.responses.triggerId, triggerId));
        expect(rows).toHaveLength(1);
      } finally {
        await app.close();
      }
    });

    it('unknown trigger → 404', async () => {
      const app = await buildApp(env, { db: t.db, closeDb: async () => {} });
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/sdk/response',
          headers: AUTH,
          payload: {
            trigger_id: '00000000-0000-4000-8000-000000000000',
            rating_value: 5,
            device_os: 'android 14',
            app_version: '1.0.0',
            shown_at: '2026-07-09T10:00:00Z',
            responded_at: '2026-07-09T10:00:05Z',
          },
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().error.code).toBe('unknown_trigger');
      } finally {
        await app.close();
      }
    });

    it('emoji campaign + rating 4 → 422 invalid_rating', async () => {
      await seedEmojiCampaign(t.db, accountId);
      const app = await buildApp(env, { db: t.db, closeDb: async () => {} });
      try {
        const elig = await app.inject({
          method: 'GET',
          url: '/v1/sdk/eligibility',
          query: { screen_id: 'new_customer_creation', user_id: 'u_e' },
          headers: AUTH,
        });
        const triggerId = elig.json().trigger_id as string;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/sdk/response',
          headers: AUTH,
          payload: {
            trigger_id: triggerId,
            rating_value: 4,
            device_os: 'android 14',
            app_version: '1.0.0',
            shown_at: '2026-07-09T10:00:00Z',
            responded_at: '2026-07-09T10:00:05Z',
          },
        });
        expect(res.statusCode).toBe(422);
        expect(res.json().error.code).toBe('invalid_rating');
      } finally {
        await app.close();
      }
    });
  });

  describe('scenario 7: dismiss', () => {
    it('valid → 204', async () => {
      await seedStarCampaign(t.db, accountId);
      const app = await buildApp(env, { db: t.db, closeDb: async () => {} });
      try {
        const elig = await app.inject({
          method: 'GET',
          url: '/v1/sdk/eligibility',
          query: { screen_id: 'order_completion', user_id: 'u_d' },
          headers: AUTH,
        });
        const triggerId = elig.json().trigger_id as string;

        const res = await app.inject({
          method: 'POST',
          url: '/v1/sdk/dismiss',
          headers: AUTH,
          payload: {
            trigger_id: triggerId,
            shown_at: '2026-07-09T10:00:00Z',
            dismissed_at: '2026-07-09T10:00:03Z',
          },
        });
        expect(res.statusCode).toBe(204);
      } finally {
        await app.close();
      }
    });
  });

  describe('scenario 8: malformed JSON', () => {
    it('returns 422 and a defined status without hanging', async () => {
      const app = await buildApp(env, { db: t.db, closeDb: async () => {} });
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/sdk/response',
          headers: { ...AUTH, 'content-type': 'application/json' },
          payload: '{ not json',
        });
        expect(res.statusCode).toBe(422);
        expect(res.json().error).toBeDefined();
      } finally {
        await app.close();
      }
    });
  });
});
