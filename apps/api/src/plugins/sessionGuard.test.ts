import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAccount, startTestDb } from '../../test/testDb.js';
import * as s from '../db/schema.js';
import { sessionGuard } from './sessionGuard.js';

const SECRET = 'test-session-secret-16chars-min';

describe('sessionGuard plugin (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: ReturnType<typeof Fastify>;
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

    app = Fastify({ logger: false });
    await app.register(cookie, { secret: SECRET });
    await app.register(async (scope: FastifyInstance) => {
      await scope.register(sessionGuard({ db: t.db }));
      scope.get('/protected', async (request) => ({
        userId: request.consoleUserId,
        accountId: request.accountId,
      }));
    });
    app.get('/open', async () => ({ open: true }));
    await app.ready();
  });

  it('rejects a request with no session cookie (401 unauthorized)', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
    await app.close();
  });

  it('rejects a tampered/invalid signature cookie (401)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { cookie: `signal_session=${userId}.not-a-valid-signature` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('accepts a valid signed cookie and sets consoleUserId + accountId', async () => {
    const signed = app.signCookie(userId);
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { cookie: `signal_session=${signed}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId, accountId });
    await app.close();
  });

  it('a stale session (user no longer exists) → 401', async () => {
    const signed = app.signCookie('00000000-0000-4000-8000-000000000000');
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { cookie: `signal_session=${signed}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
    await app.close();
  });

  it('does not leak the guard to sibling top-level routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/open' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ open: true });
    await app.close();
  });
});
