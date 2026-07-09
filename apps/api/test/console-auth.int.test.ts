// apps/api/test/console-auth.int.test.ts
import { sessionUserSchema } from '@signal/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import type { Db } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import { parseEnv } from '../src/env.js';
import { startTestDb } from './testDb.js';

const env = parseEnv({ NODE_ENV: 'test', SIGNAL_APP_KEYS: 'test-app-key' });

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'somepassword';

async function seedAdmin(db: Db) {
  await db.insert(s.consoleUsers).values({
    email: ADMIN_EMAIL,
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    name: 'Admin User',
    role: 'admin',
  });
}

function sessionCookie(setCookie: string | string[] | undefined): string | undefined {
  if (!setCookie) return undefined;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  return cookies.find((c) => c.startsWith('signal_session='));
}

describe('/v1/console/auth (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    await seedAdmin(t.db);
  });

  describe('POST /v1/console/auth/login', () => {
    let app: Awaited<ReturnType<typeof buildApp>>;
    beforeEach(async () => {
      app = await buildApp(env, { db: t.db, closeDb: async () => {} });
    });
    afterEach(async () => {
      await app.close();
    });

    it('scenario 1: correct creds → 200, session user body, httpOnly Set-Cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/console/auth/login',
        payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(sessionUserSchema.safeParse(body).success).toBe(true);
      expect(body.email).toBe(ADMIN_EMAIL);
      expect(body).not.toHaveProperty('passwordHash');

      const cookie = sessionCookie(res.headers['set-cookie']);
      expect(cookie).toBeDefined();
      expect(cookie).toMatch(/HttpOnly/i);
      // sameSite=strict is part of the M2-D2 contract and regresses silently
      expect(cookie).toMatch(/SameSite=Strict/i);
      // signed cookie carries a value beyond the bare userId
      expect(cookie).not.toBe(`signal_session=${body.id}`);
    });

    it('scenario 2: wrong password → 401 invalid_credentials, no cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/console/auth/login',
        payload: { email: ADMIN_EMAIL, password: 'wrongpassword' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('invalid_credentials');
      expect(sessionCookie(res.headers['set-cookie'])).toBeUndefined();
    });

    it('scenario 3: unknown email → 401 invalid_credentials (no enumeration), no cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/console/auth/login',
        payload: { email: 'nobody@example.com', password: ADMIN_PASSWORD },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('invalid_credentials');
      expect(sessionCookie(res.headers['set-cookie'])).toBeUndefined();
    });

    it('scenario 4: malformed body → 422', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/console/auth/login',
        payload: { email: 'not-an-email', password: '' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBeDefined();
    });
  });

  describe('rate limit', () => {
    it('scenario 5: 6th login within a minute from one IP → 429', async () => {
      const app = await buildApp(env, { db: t.db, closeDb: async () => {} });
      try {
        const attempt = () =>
          app.inject({
            method: 'POST',
            url: '/v1/console/auth/login',
            payload: { email: ADMIN_EMAIL, password: 'wrongpassword' },
            remoteAddress: '203.0.113.7',
          });
        const codes: number[] = [];
        for (let i = 0; i < 6; i++) {
          codes.push((await attempt()).statusCode);
        }
        expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
        expect(codes[5]).toBe(429);
      } finally {
        await app.close();
      }
    });
  });

  describe('logout + me round-trip', () => {
    it('login → me returns user; logout clears; me → 401', async () => {
      const app = await buildApp(env, { db: t.db, closeDb: async () => {} });
      try {
        const login = await app.inject({
          method: 'POST',
          url: '/v1/console/auth/login',
          payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        });
        const cookie = sessionCookie(login.headers['set-cookie']) ?? '';
        const cookieHeader = cookie.split(';')[0] ?? '';

        const me = await app.inject({
          method: 'GET',
          url: '/v1/console/auth/me',
          headers: { cookie: cookieHeader },
        });
        expect(me.statusCode).toBe(200);
        expect(me.json().email).toBe(ADMIN_EMAIL);

        const logout = await app.inject({
          method: 'POST',
          url: '/v1/console/auth/logout',
          headers: { cookie: cookieHeader },
        });
        expect(logout.statusCode).toBe(204);

        const meNoAuth = await app.inject({ method: 'GET', url: '/v1/console/auth/me' });
        expect(meNoAuth.statusCode).toBe(401);
        expect(meNoAuth.json().error.code).toBe('unauthorized');
      } finally {
        await app.close();
      }
    });

    it('me with a tampered cookie signature → 401 (unsign rejects it)', async () => {
      const app = await buildApp(env, { db: t.db, closeDb: async () => {} });
      try {
        const login = await app.inject({
          method: 'POST',
          url: '/v1/console/auth/login',
          payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        });
        const cookie = sessionCookie(login.headers['set-cookie']) ?? '';
        const valid = cookie.split(';')[0] ?? '';
        // Flip the last character of the signed value to break the signature.
        const tampered = valid.slice(0, -1) + (valid.endsWith('a') ? 'b' : 'a');

        const me = await app.inject({
          method: 'GET',
          url: '/v1/console/auth/me',
          headers: { cookie: tampered },
        });
        expect(me.statusCode).toBe(401);
        expect(me.json().error.code).toBe('unauthorized');
      } finally {
        await app.close();
      }
    });
  });
});
