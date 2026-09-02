// apps/api/test/google-auth.int.test.ts
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { GoogleProfile } from '../src/auth/google.js';
import { hashPassword } from '../src/auth/password.js';
import * as s from '../src/db/schema.js';
import { parseEnv } from '../src/env.js';
import { seedAccount, startTestDb } from './testDb.js';

// Google configured (both id+secret) → routes active. A second env without the
// credentials exercises the "not configured → 503" path.
const env = parseEnv({
  NODE_ENV: 'test',
  GOOGLE_CLIENT_ID: 'gid',
  GOOGLE_CLIENT_SECRET: 'gsecret',
});
const envNoGoogle = parseEnv({ NODE_ENV: 'test' });

// Stub the code→profile exchange keyed by the fake `code`, so the callback never
// hits Google. An unknown code throws (mirrors a failed real exchange).
const PROFILES: Record<string, GoogleProfile> = {
  new: { sub: 'g-new', email: 'newuser@example.com', emailVerified: true, name: 'New User' },
  existing: { sub: 'g-existing', email: 'link@example.com', emailVerified: true, name: 'Linked' },
  unverified: { sub: 'g-unv', email: 'unv@example.com', emailVerified: false, name: 'Unv' },
};
const exchange = async (code: string): Promise<GoogleProfile> => {
  const p = PROFILES[code];
  if (!p) throw new Error('bad code');
  return p;
};

/** Full `name=value` for a Set-Cookie of the given name (or undefined). */
function setCookie(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const sc = res.headers['set-cookie'];
  const arr = Array.isArray(sc) ? sc : sc ? [sc as string] : [];
  return arr.find((c) => c.startsWith(`${name}=`));
}
/** The `name=value` pair (drop attributes) suitable to echo back as a request cookie. */
function pair(cookieStr: string | undefined): string {
  return (cookieStr ?? '').split(';')[0] ?? '';
}

describe('/v1/console/auth/google (real Postgres)', () => {
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
    app = await buildApp(env, { db: t.db, closeDb: async () => {}, googleExchange: exchange });
  });
  afterEach(async () => {
    await app.close();
  });

  /** Run the start route and return the state + the oauth cookie pair to replay. */
  async function start(next = '/dashboard') {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/auth/google?next=${encodeURIComponent(next)}`,
    });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    const state = new URL(location).searchParams.get('state') ?? '';
    return { location, state, cookie: pair(setCookie(res, 'signal_oauth')) };
  }

  it('start → 302 to Google consent with client_id, redirect_uri, state + lax cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/console/auth/google?next=/dashboard' });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(loc.searchParams.get('client_id')).toBe('gid');
    expect(loc.searchParams.get('redirect_uri')).toContain('/v1/console/auth/google/callback');
    expect(loc.searchParams.get('state')).toBeTruthy();
    const oauth = setCookie(res, 'signal_oauth');
    expect(oauth).toMatch(/HttpOnly/i);
    expect(oauth).toMatch(/SameSite=Lax/i); // MUST be lax to survive the cross-site return
  });

  it('start → 503 when Google is not configured', async () => {
    const noG = await buildApp(envNoGoogle, { db: t.db, closeDb: async () => {} });
    const res = await noG.inject({ method: 'GET', url: '/v1/console/auth/google' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('google_not_configured');
    await noG.close();
  });

  it('callback (new user) → creates account+user+key, sets session, redirects to next', async () => {
    const { state, cookie } = await start('/dashboard');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/auth/google/callback?code=new&state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
    const session = setCookie(res, 'signal_session');
    expect(session).toMatch(/HttpOnly/i);

    // The session is real: /me returns the new user.
    const me = await app.inject({
      method: 'GET',
      url: '/v1/console/auth/me',
      headers: { cookie: pair(session) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe('newuser@example.com');
    expect(me.json().provider).toBe('google');

    // DB: user linked by google_sub, null password; a default key exists.
    const [user] = await t.db
      .select()
      .from(s.consoleUsers)
      .where(eq(s.consoleUsers.email, 'newuser@example.com'));
    if (!user) throw new Error('expected new user row');
    expect(user.googleSub).toBe('g-new');
    expect(user.passwordHash).toBeNull();
    const keys = await t.db.select().from(s.apiKeys).where(eq(s.apiKeys.accountId, user.accountId));
    expect(keys.length).toBe(1);
  });

  it('callback with mismatched state → redirect to /login?error=google_state, no session', async () => {
    const { cookie } = await start();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/console/auth/google/callback?code=new&state=WRONG',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?error=google_state');
    expect(setCookie(res, 'signal_session')).toBeUndefined();
  });

  it('failure from an /app flow bounces back to /app/login (not the server login)', async () => {
    const { cookie } = await start('/app/dashboard');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/console/auth/google/callback?code=new&state=WRONG',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/app/login?error=google_state');
  });

  it('callback links Google to an existing account by verified email', async () => {
    // Seed a password user whose email matches the Google profile "link@example.com".
    const accountId = await seedAccount(t.db, 'Existing Co');
    await t.db.insert(s.consoleUsers).values({
      accountId,
      email: 'link@example.com',
      passwordHash: await hashPassword('somepassword'),
      name: 'Existing',
      role: 'admin',
    });

    const { state, cookie } = await start();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/auth/google/callback?code=existing&state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard');

    // Same row, now linked — no duplicate account created.
    const rows = await t.db
      .select()
      .from(s.consoleUsers)
      .where(eq(s.consoleUsers.email, 'link@example.com'));
    expect(rows.length).toBe(1);
    const [row] = rows;
    if (!row) throw new Error('expected linked user row');
    expect(row.googleSub).toBe('g-existing');
    expect(row.accountId).toBe(accountId);
  });

  it('callback with unverified Google email → redirect error, no user created', async () => {
    const { state, cookie } = await start();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/console/auth/google/callback?code=unverified&state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login?error=google_unverified');
    const rows = await t.db
      .select()
      .from(s.consoleUsers)
      .where(and(eq(s.consoleUsers.email, 'unv@example.com'), isNull(s.consoleUsers.passwordHash)));
    expect(rows.length).toBe(0);
  });
});
