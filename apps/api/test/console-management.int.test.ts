import { CLI_TOKEN_PATTERN } from '@signal/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { parseEnv } from '../src/env.js';
import { TokenService } from '../src/tokens/service.js';
import { seedAccountWithUser, startTestDb } from './testDb.js';

const env = parseEnv({ NODE_ENV: 'test' });

describe('/v1/console key & token management (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let accountA: string;
  let tokenA: string;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    const a = await seedAccountWithUser(t.db as Db, { email: 'a@example.com' });
    accountA = a.accountId;
    tokenA = (await new TokenService(t.db).issue(accountA, 'a-admin')).token;
    app = await buildApp(env, { db: t.db, closeDb: async () => {} });
  });
  afterEach(async () => {
    await app.close();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it('creates, lists, and revokes a publishable key with allowed_origins', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/console/keys',
      headers: auth(tokenA),
      payload: { label: 'web', environment: 'live', allowed_origins: ['https://acme.com'] },
    });
    expect(created.statusCode).toBe(201);
    const key = created.json();
    expect(key.key).toMatch(/^pk_live_/);
    expect(key.allowed_origins).toEqual(['https://acme.com']);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/console/keys',
      headers: auth(tokenA),
    });
    expect(list.statusCode).toBe(200);
    // signup does not run here (we seeded directly), so exactly the one we created
    expect(list.json().keys).toHaveLength(1);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/console/keys/${key.id}`,
      headers: auth(tokenA),
    });
    expect(del.statusCode).toBe(204);
    const afterList = await app.inject({
      method: 'GET',
      url: '/v1/console/keys',
      headers: auth(tokenA),
    });
    expect(afterList.json().keys[0].revoked_at).not.toBeNull();
  });

  it('creates a CLI token (plaintext once), lists metadata only, and revokes it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/console/cli-tokens',
      headers: auth(tokenA),
      payload: { name: 'ci', scopes: ['deploy'] },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(CLI_TOKEN_PATTERN.test(body.token)).toBe(true);
    expect(body.scopes).toEqual(['deploy']);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/console/cli-tokens',
      headers: auth(tokenA),
    });
    // the admin token + the one just created
    const names = list.json().tokens.map((x: { name: string }) => x.name);
    expect(names).toContain('ci');
    // plaintext NEVER appears on list
    expect(JSON.stringify(list.json())).not.toContain(body.token);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/console/cli-tokens/${body.id}`,
      headers: auth(tokenA),
    });
    expect(del.statusCode).toBe(204);
    // the revoked token no longer authenticates
    const denied = await app.inject({
      method: 'GET',
      url: '/v1/console/workflows',
      headers: auth(body.token),
    });
    expect(denied.statusCode).toBe(401);
  });

  it('isolates keys and tokens across accounts', async () => {
    // account A creates a key + token
    await app.inject({
      method: 'POST',
      url: '/v1/console/keys',
      headers: auth(tokenA),
      payload: { label: 'a-key' },
    });
    const aTok = await app.inject({
      method: 'POST',
      url: '/v1/console/cli-tokens',
      headers: auth(tokenA),
      payload: { name: 'a-tok' },
    });

    // account B sees none of A's
    const b = await seedAccountWithUser(t.db as Db, { email: 'b@example.com' });
    const tokenB = (await new TokenService(t.db).issue(b.accountId, 'b-admin')).token;

    const bKeys = await app.inject({
      method: 'GET',
      url: '/v1/console/keys',
      headers: auth(tokenB),
    });
    expect(bKeys.json().keys).toHaveLength(0);
    const bTokens = await app.inject({
      method: 'GET',
      url: '/v1/console/cli-tokens',
      headers: auth(tokenB),
    });
    // only B's own admin token
    expect(bTokens.json().tokens.map((x: { name: string }) => x.name)).toEqual(['b-admin']);

    // B cannot revoke A's token (404, and A's token still works)
    const crossRevoke = await app.inject({
      method: 'DELETE',
      url: `/v1/console/cli-tokens/${aTok.json().id}`,
      headers: auth(tokenB),
    });
    expect(crossRevoke.statusCode).toBe(404);
    const aStillWorks = await app.inject({
      method: 'GET',
      url: '/v1/console/workflows',
      headers: auth(aTok.json().token),
    });
    expect(aStillWorks.statusCode).toBe(200);
  });

  it('a read-only token cannot create a key (403 insufficient_scope)', async () => {
    const ro = (await new TokenService(t.db).issue(accountA, 'ro', { scopes: ['workflows:read'] }))
      .token;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/console/keys',
      headers: auth(ro),
      payload: { label: 'nope' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
  });
});
