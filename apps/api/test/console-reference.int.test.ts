// apps/api/test/console-reference.int.test.ts
import { targetSchema } from '@signal/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import { parseEnv } from '../src/env.js';
import { seedAccountWithUser, startTestDb } from './testDb.js';

const env = parseEnv({ NODE_ENV: 'test' });

async function seedTargets(db: Db, accountId: string) {
  await db.insert(s.targetRegistry).values([
    {
      accountId,
      name: 'Beta Screen',
      screenId: 'beta',
      triggerMechanism: 'action',
      integrationStatus: 'not_sent',
    },
    {
      accountId,
      name: 'Alpha Screen',
      screenId: 'alpha',
      triggerMechanism: 'dwell',
      integrationStatus: 'confirmed_live',
    },
  ]);
}

describe('/v1/console reference read routes (real Postgres)', () => {
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

  describe('GET /v1/console/targets', () => {
    it('without a cookie → 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/console/targets' });
      expect(res.statusCode).toBe(401);
    });

    it('with a cookie, after seeding 2 targets → 200 array of 2 matching targetSchema', async () => {
      await seedTargets(t.db, accountId);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/console/targets',
        headers: { cookie: cookieHeader },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
      for (const row of body) {
        expect(targetSchema.safeParse(row).success).toBe(true);
      }
      // ordered by name
      expect(body.map((r: { name: string }) => r.name)).toEqual(['Alpha Screen', 'Beta Screen']);
    });
  });

  describe('POST /v1/console/targets', () => {
    it('without a cookie → 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/console/targets',
        payload: { name: 'Order Completion', trigger_mechanism: 'action' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('creates a target with a server-side slug and integration_status=not_sent', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/console/targets',
        headers: { cookie: cookieHeader },
        payload: { name: 'Order Completion', trigger_mechanism: 'action' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(targetSchema.safeParse(body).success).toBe(true);
      expect(body.screen_id).toBe('order_completion');
      expect(body.integration_status).toBe('not_sent');
      expect(body.name).toBe('Order Completion');
      expect(body.trigger_mechanism).toBe('action');
      expect(typeof body.id).toBe('string');

      // The row is actually persisted.
      const rows = await t.db.select().from(s.targetRegistry);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.screenId).toBe('order_completion');
    });

    it('rejects a slug collision with 422 slug_conflict (no auto-suffix, only one row)', async () => {
      const first = await app.inject({
        method: 'POST',
        url: '/v1/console/targets',
        headers: { cookie: cookieHeader },
        payload: { name: 'Order Completion', trigger_mechanism: 'action' },
      });
      expect(first.statusCode).toBe(201);

      // A different name that slugifies to the SAME screen_id.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/console/targets',
        headers: { cookie: cookieHeader },
        payload: { name: 'Order  Completion!!', trigger_mechanism: 'dwell' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('slug_conflict');

      const rows = await t.db.select().from(s.targetRegistry);
      expect(rows).toHaveLength(1);
    });

    it('rejects a blank name with 422 invalid_body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/console/targets',
        headers: { cookie: cookieHeader },
        payload: { name: '', trigger_mechanism: 'action' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('invalid_body');
    });

    it('rejects a missing trigger_mechanism with 422 invalid_body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/console/targets',
        headers: { cookie: cookieHeader },
        payload: { name: 'No Mechanism' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('invalid_body');
    });

    it('rejects a name with no sluggable characters with 422 invalid_body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/console/targets',
        headers: { cookie: cookieHeader },
        payload: { name: '!!!', trigger_mechanism: 'action' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('invalid_body');
    });
  });

  describe('PATCH /v1/console/targets/:id/integration-status', () => {
    // Seed one target at a known integration_status and return its id.
    async function seedTargetAt(
      db: Db,
      integrationStatus: 'not_sent' | 'sent_to_engineering' | 'confirmed_live',
    ): Promise<string> {
      const [row] = await db
        .insert(s.targetRegistry)
        .values({
          accountId,
          name: `Target ${integrationStatus}`,
          screenId: `target_${integrationStatus}`,
          triggerMechanism: 'action',
          integrationStatus,
        })
        .returning();
      if (!row) throw new Error('seed failed');
      return row.id;
    }

    async function statusOf(db: Db, id: string): Promise<string | undefined> {
      const rows = await db.select().from(s.targetRegistry);
      return rows.find((r) => r.id === id)?.integrationStatus;
    }

    it('without a cookie → 401', async () => {
      const id = await seedTargetAt(t.db, 'not_sent');
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/console/targets/${id}/integration-status`,
        payload: { to: 'sent_to_engineering' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('not_sent → sent_to_engineering → 200 and persists', async () => {
      const id = await seedTargetAt(t.db, 'not_sent');
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/console/targets/${id}/integration-status`,
        headers: { cookie: cookieHeader },
        payload: { to: 'sent_to_engineering' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(targetSchema.safeParse(body).success).toBe(true);
      expect(body.integration_status).toBe('sent_to_engineering');
      expect(await statusOf(t.db, id)).toBe('sent_to_engineering');
    });

    it('confirmed_live from any state → 200 (from not_sent)', async () => {
      const id = await seedTargetAt(t.db, 'not_sent');
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/console/targets/${id}/integration-status`,
        headers: { cookie: cookieHeader },
        payload: { to: 'confirmed_live' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().integration_status).toBe('confirmed_live');
      expect(await statusOf(t.db, id)).toBe('confirmed_live');
    });

    it('confirmed_live from any state → 200 (from sent_to_engineering)', async () => {
      const id = await seedTargetAt(t.db, 'sent_to_engineering');
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/console/targets/${id}/integration-status`,
        headers: { cookie: cookieHeader },
        payload: { to: 'confirmed_live' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().integration_status).toBe('confirmed_live');
    });

    it('confirmed_live → confirmed_live is an idempotent no-op → 200 (any → confirmed_live, M2-D17)', async () => {
      const id = await seedTargetAt(t.db, 'confirmed_live');
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/console/targets/${id}/integration-status`,
        headers: { cookie: cookieHeader },
        payload: { to: 'confirmed_live' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().integration_status).toBe('confirmed_live');
      expect(await statusOf(t.db, id)).toBe('confirmed_live');
    });

    it('illegal confirmed_live → not_sent → 422 illegal_transition, DB unchanged', async () => {
      const id = await seedTargetAt(t.db, 'confirmed_live');
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/console/targets/${id}/integration-status`,
        headers: { cookie: cookieHeader },
        payload: { to: 'not_sent' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('illegal_transition');
      expect(await statusOf(t.db, id)).toBe('confirmed_live');
    });

    it('illegal sent_to_engineering → not_sent → 422 illegal_transition, DB unchanged', async () => {
      const id = await seedTargetAt(t.db, 'sent_to_engineering');
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/console/targets/${id}/integration-status`,
        headers: { cookie: cookieHeader },
        payload: { to: 'not_sent' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('illegal_transition');
      expect(await statusOf(t.db, id)).toBe('sent_to_engineering');
    });

    it('same-state no-op not_sent → not_sent → 422 illegal_transition', async () => {
      const id = await seedTargetAt(t.db, 'not_sent');
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/console/targets/${id}/integration-status`,
        headers: { cookie: cookieHeader },
        payload: { to: 'not_sent' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('illegal_transition');
    });

    it('unknown target id → 404 not_found', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/console/targets/3f0e6f2e-6f2e-4e2e-8e2e-000000000000/integration-status',
        headers: { cookie: cookieHeader },
        payload: { to: 'confirmed_live' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('bad body (unknown status) → 422 invalid_body', async () => {
      const id = await seedTargetAt(t.db, 'not_sent');
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/console/targets/${id}/integration-status`,
        headers: { cookie: cookieHeader },
        payload: { to: 'bogus' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('invalid_body');
    });
  });

  describe('target isolation', () => {
    it("A cannot see B's targets in the list", async () => {
      await seedTargets(t.db, accountId); // account A owns these two
      const b = await seedAccountWithUser(t.db, { accountName: 'B', email: 'b@example.com' });
      await t.db.insert(s.targetRegistry).values({
        accountId: b.accountId,
        name: 'B Screen',
        screenId: 'b_screen',
        triggerMechanism: 'action',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/console/targets',
        headers: { cookie: cookieHeader },
      });
      expect(res.statusCode).toBe(200);
      const names = res.json().map((r: { name: string }) => r.name);
      expect(names).toEqual(['Alpha Screen', 'Beta Screen']); // no B Screen
    });
  });

  it('regression: /v1/console/auth is NOT behind the session guard (login body validation runs without a cookie)', async () => {
    // A malformed login with no cookie must reach the route's own body validation
    // and return 422 invalid_body. If the guard had swallowed the auth subtree it
    // would 401 *before* the handler runs — so 422 uniquely proves /auth is unguarded.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/console/auth/login',
      payload: { email: 'not-an-email', password: '' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_body');
  });
});
