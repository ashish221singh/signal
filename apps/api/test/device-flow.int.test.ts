import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import type { Db } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import { parseEnv } from '../src/env.js';
import { seedAccount, startTestDb } from './testDb.js';

const env = parseEnv({ NODE_ENV: 'test' });

const EMAIL = 'owner@example.com';
const PASSWORD = 'somepassword';

async function seedOwner(db: Db): Promise<string> {
  const accountId = await seedAccount(db);
  await db.insert(s.consoleUsers).values({
    accountId,
    email: EMAIL,
    passwordHash: await hashPassword(PASSWORD),
    name: 'Owner',
    role: 'admin',
  });
  return accountId;
}

function sessionCookie(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const c = cookies.find((x) => x.startsWith('signal_session='));
  return (c?.split(';')[0] ?? '') as string;
}

describe('device flow + interim login (real Postgres)', () => {
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
    accountId = await seedOwner(t.db as Db);
    app = await buildApp(env, { db: t.db, closeDb: async () => {} });
  });
  afterEach(async () => {
    await app.close();
  });

  async function login(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/console/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    });
    return sessionCookie(res.headers['set-cookie']);
  }

  it('pending → approved → token once → spent', async () => {
    const start = await app.inject({ method: 'POST', url: '/v1/cli/device/code' });
    expect(start.statusCode).toBe(201);
    const grant = start.json();
    expect(grant.device_code).toMatch(/^dev_/);
    expect(grant.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(grant.verification_uri).toContain('/cli/approve?user_code=');
    expect(grant.interval).toBeGreaterThan(0);

    // poll before approval → 428 authorization_pending
    const pending = await app.inject({
      method: 'POST',
      url: '/v1/cli/device/token',
      payload: { device_code: grant.device_code },
    });
    expect(pending.statusCode).toBe(428);
    expect(pending.json().error.code).toBe('authorization_pending');

    // approve via the session-guarded page
    const cookie = await login();
    const approve = await app.inject({
      method: 'POST',
      url: '/cli/approve',
      headers: { cookie },
      payload: { user_code: grant.user_code, decision: 'approve' },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.body).toContain('approved');

    // poll → token issued once
    const got = await app.inject({
      method: 'POST',
      url: '/v1/cli/device/token',
      payload: { device_code: grant.device_code },
    });
    expect(got.statusCode).toBe(200);
    const tok = got.json();
    expect(tok.token).toMatch(/^cli_/);
    expect(tok.scopes).toContain('deploy');

    // the token actually works against the console API
    const list = await app.inject({
      method: 'GET',
      url: '/v1/console/workflows',
      headers: { authorization: `Bearer ${tok.token}` },
    });
    expect(list.statusCode).toBe(200);

    // second poll → the token is spent (not returned twice)
    const again = await app.inject({
      method: 'POST',
      url: '/v1/cli/device/token',
      payload: { device_code: grant.device_code },
    });
    expect(again.statusCode).toBe(404);

    // exactly one cli_token row was created for this account
    const rows = await t.db.select().from(s.cliTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountId).toBe(accountId);
  });

  it('deny → poll returns access_denied', async () => {
    const start = await app.inject({ method: 'POST', url: '/v1/cli/device/code' });
    const grant = start.json();
    const cookie = await login();
    const deny = await app.inject({
      method: 'POST',
      url: '/cli/approve',
      headers: { cookie },
      payload: { user_code: grant.user_code, decision: 'deny' },
    });
    expect(deny.statusCode).toBe(200);
    expect(deny.body).toContain('denied');

    const poll = await app.inject({
      method: 'POST',
      url: '/v1/cli/device/token',
      payload: { device_code: grant.device_code },
    });
    expect(poll.statusCode).toBe(403);
    expect(poll.json().error.code).toBe('access_denied');
  });

  it('an expired device authorization → expired_token on poll', async () => {
    const start = await app.inject({ method: 'POST', url: '/v1/cli/device/code' });
    const grant = start.json();
    // Force the row past expiry.
    await t.db.update(s.deviceAuthorizations).set({ expiresAt: new Date(Date.now() - 1000) });
    const poll = await app.inject({
      method: 'POST',
      url: '/v1/cli/device/token',
      payload: { device_code: grant.device_code },
    });
    expect(poll.statusCode).toBe(410);
    expect(poll.json().error.code).toBe('expired_token');
  });

  it('unknown device_code → invalid_grant', async () => {
    const poll = await app.inject({
      method: 'POST',
      url: '/v1/cli/device/token',
      payload: { device_code: 'dev_nope' },
    });
    expect(poll.statusCode).toBe(404);
    expect(poll.json().error.code).toBe('invalid_grant');
  });

  it('approval page redirects to /login when unauthenticated', async () => {
    const start = await app.inject({ method: 'POST', url: '/v1/cli/device/code' });
    const grant = start.json();
    const res = await app.inject({
      method: 'GET',
      url: `/cli/approve?user_code=${grant.user_code}`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/login?next=');
  });

  it('approval page renders the user_code when authenticated', async () => {
    const start = await app.inject({ method: 'POST', url: '/v1/cli/device/code' });
    const grant = start.json();
    const cookie = await login();
    const res = await app.inject({
      method: 'GET',
      url: `/cli/approve?user_code=${grant.user_code}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain(grant.user_code);
  });

  it('interim password login mints a working token (dev/test default ON)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/cli/login',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const tok = res.json();
    expect(tok.token).toMatch(/^cli_/);

    const me = await app.inject({
      method: 'GET',
      url: '/v1/console/workflows',
      headers: { authorization: `Bearer ${tok.token}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('interim login rejects bad credentials (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/cli/login',
      payload: { email: EMAIL, password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('the /signup and /login pages render HTML', async () => {
    const signup = await app.inject({ method: 'GET', url: '/signup' });
    expect(signup.statusCode).toBe(200);
    expect(signup.body).toContain('Create your Signal account');
    const login = await app.inject({ method: 'GET', url: '/login' });
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain('Log in to Signal');
  });
});

describe('interim login gated OFF in production (B3-D4, GR-10)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });
  beforeEach(async () => {
    await t.truncateAll();
    await seedOwner(t.db as Db);
  });

  it('POST /v1/cli/login → 403 password_login_disabled', async () => {
    const prodEnv = parseEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      SESSION_SECRET: 'a-sufficiently-long-secret',
      S3_ACCESS_KEY: 'AKIA',
      S3_SECRET_KEY: 'secret',
    });
    const app = await buildApp(prodEnv, { db: t.db, closeDb: async () => {} });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/cli/login',
        payload: { email: EMAIL, password: PASSWORD },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('password_login_disabled');
    } finally {
      await app.close();
    }
  });
});
