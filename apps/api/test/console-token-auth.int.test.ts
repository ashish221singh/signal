import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { parseEnv } from '../src/env.js';
import { TokenService } from '../src/tokens/service.js';
import { seedAccountWithUser, startTestDb } from './testDb.js';

const env = parseEnv({ NODE_ENV: 'test' });

/**
 * Unified-auth over the REAL console API (B3-D5): a `/v1/console/*` route accepts a
 * cookie session OR a Bearer CLI token, and per-route scope guards 403 a token that
 * lacks the scope. Complements the plugin-level resolveAuth.test.ts.
 */
describe('/v1/console/* Bearer-token auth (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let accountId: string;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    const seeded = await seedAccountWithUser(t.db as Db);
    accountId = seeded.accountId;
    app = await buildApp(env, { db: t.db, closeDb: async () => {} });
  });
  afterEach(async () => {
    await app.close();
  });

  it('no credential → 401 on GET /v1/console/workflows', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/console/workflows' });
    expect(res.statusCode).toBe(401);
  });

  it('a full-scope token lists workflows (via token)', async () => {
    const { token } = await new TokenService(t.db).issue(accountId, 'ci');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/console/workflows',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('a token can create a workflow (created_by falls back to a token marker)', async () => {
    const { token } = await new TokenService(t.db).issue(accountId, 'ci');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/console/workflows',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().created_by).toBe('cli-token');
  });

  it("another account's token cannot see this account's workflows (isolation)", async () => {
    // Seed a workflow under `accountId`.
    const { token } = await new TokenService(t.db).issue(accountId, 'ci');
    await app.inject({
      method: 'POST',
      url: '/v1/console/workflows',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    // A token for a DIFFERENT account sees nothing.
    const other = await seedAccountWithUser(t.db as Db, { email: 'b@example.com' });
    const { token: otherToken } = await new TokenService(t.db).issue(other.accountId, 'ci');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/console/workflows',
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(0);
  });
});
