// apps/api/test/signup.int.test.ts
import { signupResponseSchema } from '@signal/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/env.js';
import { startTestDb } from './testDb.js';

const env = parseEnv({ NODE_ENV: 'test' });

function sessionCookie(setCookie: string | string[] | undefined): string | undefined {
  if (!setCookie) return undefined;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  return cookies.find((c) => c.startsWith('signal_session='));
}

describe('POST /v1/console/auth/signup (real Postgres)', () => {
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
    app = await buildApp(env, { db: t.db, closeDb: async () => {} });
  });
  afterEach(async () => {
    await app.close();
  });

  const body = {
    email: 'owner@example.com',
    password: 'password8',
    name: 'Owner',
    account_name: 'Acme',
  };

  it('signup → 201 with account/user/publishable_key, sets a session cookie, /me works', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/console/auth/signup',
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const parsed = res.json();
    expect(signupResponseSchema.safeParse(parsed).success).toBe(true);
    expect(parsed.publishable_key).toMatch(/^pk_live_[A-Za-z0-9]{24}$/);
    expect(parsed.user.role).toBe('admin');

    const cookie = sessionCookie(res.headers['set-cookie']);
    expect(cookie).toBeDefined();
    const cookieHeader = (cookie ?? '').split(';')[0] ?? '';

    const me = await app.inject({
      method: 'GET',
      url: '/v1/console/auth/me',
      headers: { cookie: cookieHeader },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe(body.email);
  });

  it('duplicate email → 409 email_taken', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/console/auth/signup',
      payload: body,
    });
    expect(first.statusCode).toBe(201);

    const dupe = await app.inject({
      method: 'POST',
      url: '/v1/console/auth/signup',
      payload: { ...body, account_name: 'Other', name: 'Other' },
    });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error.code).toBe('email_taken');
  });

  it('short password → 422 invalid_body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/console/auth/signup',
      payload: { ...body, password: 'short7!' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_body');
  });

  it('6th signup within a minute from one IP → 429', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/console/auth/signup',
        payload: { ...body, email: `user${i}@example.com`, account_name: `Co ${i}` },
        remoteAddress: '203.0.113.9',
      });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 201)).toBe(true);
    expect(codes[5]).toBe(429);
  });
});
