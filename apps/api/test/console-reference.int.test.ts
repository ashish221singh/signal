// apps/api/test/console-reference.int.test.ts
import { clientSchema, targetSchema } from '@signal/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import { parseEnv } from '../src/env.js';
import { startTestDb } from './testDb.js';

const env = parseEnv({ NODE_ENV: 'test', SIGNAL_APP_KEYS: 'test-app-key' });

const USER_ID = '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e';

async function seedTargets(db: Db) {
  await db.insert(s.targetRegistry).values([
    {
      name: 'Beta Screen',
      screenId: 'beta',
      triggerMechanism: 'action',
      integrationStatus: 'not_sent',
    },
    {
      name: 'Alpha Screen',
      screenId: 'alpha',
      triggerMechanism: 'dwell',
      integrationStatus: 'confirmed_live',
    },
  ]);
}

async function seedClients(db: Db) {
  await db.insert(s.clients).values([
    { id: 'c-gamma', name: 'Gamma', status: 'active' },
    { id: 'c-alpha', name: 'Alpha', status: 'inactive' },
    { id: 'c-beta', name: 'Beta', status: 'active' },
  ]);
}

describe('/v1/console reference read routes (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  // A validly-signed session cookie; the guard only checks the signature, not
  // that the user row exists.
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

  describe('GET /v1/console/targets', () => {
    it('without a cookie → 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/console/targets' });
      expect(res.statusCode).toBe(401);
    });

    it('with a cookie, after seeding 2 targets → 200 array of 2 matching targetSchema', async () => {
      await seedTargets(t.db);
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

  describe('GET /v1/console/clients', () => {
    it('without a cookie → 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/console/clients' });
      expect(res.statusCode).toBe(401);
    });

    it('with a cookie, after seeding 3 clients → 200 array of 3 matching clientSchema', async () => {
      await seedClients(t.db);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/console/clients',
        headers: { cookie: cookieHeader },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(3);
      for (const row of body) {
        expect(clientSchema.safeParse(row).success).toBe(true);
      }
      expect(body.map((r: { name: string }) => r.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
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
