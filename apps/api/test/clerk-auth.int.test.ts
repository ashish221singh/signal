// apps/api/test/clerk-auth.int.test.ts
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ClerkAuth } from '../src/auth/clerk.js';
import * as s from '../src/db/schema.js';
import { parseEnv } from '../src/env.js';
import { startTestDb } from './testDb.js';

const env = parseEnv({ NODE_ENV: 'test' });

// Stub Clerk: 'good' → a known user; anything else → invalid.
const clerk: ClerkAuth = {
  verify: async (token) => (token === 'good' ? 'clerk_user_abc' : null),
  getUser: async (id) =>
    id === 'clerk_user_abc' ? { email: 'clerk@example.com', name: 'Clerk User' } : null,
};

describe('Clerk dashboard auth (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });
  beforeEach(async () => {
    await t.truncateAll();
    app = await buildApp(env, { db: t.db, closeDb: async () => {}, clerk });
  });
  afterEach(async () => {
    await app.close();
  });

  it('a valid Clerk token → 200 on a guarded route + creates the account on first use', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/console/events/overview',
      headers: { authorization: 'Bearer good' },
    });
    expect(res.statusCode).toBe(200);

    const [user] = await t.db
      .select()
      .from(s.consoleUsers)
      .where(eq(s.consoleUsers.clerkUserId, 'clerk_user_abc'));
    expect(user.email).toBe('clerk@example.com');
    expect(user.passwordHash).toBeNull();
    // default publishable key issued for the new account
    const keys = await t.db.select().from(s.apiKeys).where(eq(s.apiKeys.accountId, user.accountId));
    expect(keys.length).toBe(1);
  });

  it('a second request for the same Clerk user reuses the account (no duplicate)', async () => {
    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/console/events/overview',
        headers: { authorization: 'Bearer good' },
      });
      expect(res.statusCode).toBe(200);
    }
    const rows = await t.db
      .select()
      .from(s.consoleUsers)
      .where(eq(s.consoleUsers.clerkUserId, 'clerk_user_abc'));
    expect(rows.length).toBe(1);
  });

  it('an invalid Clerk token → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/console/events/overview',
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.statusCode).toBe(401);
  });
});
