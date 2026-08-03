import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAccount, startTestDb } from '../../test/testDb.js';
import * as s from '../db/schema.js';
import { TokenService } from '../tokens/service.js';
import { requireScope, resolveAuth } from './resolveAuth.js';

const SECRET = 'test-session-secret-16chars-min';

describe('resolveAuth plugin (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: ReturnType<typeof Fastify>;
  let accountId: string;
  let userId: string;
  let tokens: TokenService;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    accountId = await seedAccount(t.db);
    const [user] = await t.db
      .insert(s.consoleUsers)
      .values({
        accountId,
        email: 'guard@example.com',
        passwordHash: 'x',
        name: 'Guard',
        role: 'admin',
      })
      .returning();
    userId = user!.id;
    tokens = new TokenService(t.db);

    app = Fastify({ logger: false });
    await app.register(cookie, { secret: SECRET });
    await app.register(async (scope: FastifyInstance) => {
      await scope.register(resolveAuth({ db: t.db, tokens }));
      scope.get('/protected', async (request) => ({
        userId: request.consoleUserId ?? null,
        accountId: request.accountId,
        via: request.auth?.via,
        scopes: request.auth?.scopes,
      }));
      scope.get('/deploy-only', { preHandler: requireScope('deploy') }, async () => ({ ok: true }));
    });
    app.get('/open', async () => ({ open: true }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── session path ──
  it('rejects a request with no credential (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('accepts a valid session cookie ⇒ via=session, all scopes', async () => {
    const signed = app.signCookie(userId);
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { cookie: `signal_session=${signed}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ userId, accountId, via: 'session' });
    expect(body.scopes).toEqual(['workflows:read', 'workflows:write', 'responses:read', 'deploy']);
  });

  it('a stale session (user gone) → 401', async () => {
    const signed = app.signCookie('00000000-0000-4000-8000-000000000000');
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { cookie: `signal_session=${signed}` },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── token path ──
  it('accepts a valid Bearer token ⇒ via=token, token account + scopes', async () => {
    const { token } = await tokens.issue(accountId, 'ci', { scopes: ['workflows:read'] });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      accountId,
      via: 'token',
      scopes: ['workflows:read'],
      userId: null,
    });
  });

  it('rejects an unknown/expired Bearer token (401)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer cli_${'z'.repeat(32)}` },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── scope enforcement ──
  it('session passes requireScope(deploy) (all scopes)', async () => {
    const signed = app.signCookie(userId);
    const res = await app.inject({
      method: 'GET',
      url: '/deploy-only',
      headers: { cookie: `signal_session=${signed}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('a token WITHOUT the deploy scope → 403 insufficient_scope', async () => {
    const { token } = await tokens.issue(accountId, 'ro', { scopes: ['workflows:read'] });
    const res = await app.inject({
      method: 'GET',
      url: '/deploy-only',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
  });

  it('a token WITH the deploy scope → 200', async () => {
    const { token } = await tokens.issue(accountId, 'dep', { scopes: ['deploy'] });
    const res = await app.inject({
      method: 'GET',
      url: '/deploy-only',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('does not leak the guard to sibling top-level routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/open' });
    expect(res.statusCode).toBe(200);
  });
});
