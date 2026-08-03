// apps/api/test/sdk-hardening.int.test.ts
// Hardening-lite on /v1/sdk/* (B2-D7): per-(key+user) rate limit → 429; a
// per-account origin allow-list enforced ONLY when an Origin header is present
// (native SDKs send none and pass) → 403.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/env.js';
import { seedAccount, seedApiKey, startTestDb } from './testDb.js';

const KEY = 'pk_test_hardeningxxxxxxxxxxx';

describe('SDK hardening: rate limit (real Postgres)', () => {
  // A tiny limit makes the 429 boundary deterministic.
  const env = parseEnv({ NODE_ENV: 'test', SDK_RATE_LIMIT_MAX: '3' });
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
    accountId = await seedAccount(t.db);
    await seedApiKey(t.db, accountId, KEY);
    app = await buildApp(env, { db: t.db, closeDb: async () => {} });
  });
  afterEach(async () => {
    await app.close();
  });

  it('over the per-(key+user) limit → 429 rate_limited', async () => {
    const hit = () =>
      app.inject({
        method: 'GET',
        url: '/v1/sdk/eligibility',
        query: { event_name: 'checkout_completed', user_id: 'u_limit' },
        headers: { 'x-signal-app-key': KEY },
      });
    // First 3 pass the limiter (they 204 — no active workflow — but not 429).
    for (let i = 0; i < 3; i++) {
      const res = await hit();
      expect(res.statusCode).not.toBe(429);
    }
    const over = await hit();
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('rate_limited');
  });

  it('the limit is per user_id — a different user is not throttled by another', async () => {
    const hitFor = (user: string) =>
      app.inject({
        method: 'GET',
        url: '/v1/sdk/eligibility',
        query: { event_name: 'checkout_completed', user_id: user },
        headers: { 'x-signal-app-key': KEY },
      });
    for (let i = 0; i < 4; i++) await hitFor('user_a');
    // user_b starts fresh — its first call is not 429.
    const res = await hitFor('user_b');
    expect(res.statusCode).not.toBe(429);
  });
});

describe('SDK hardening: origin allow-list (real Postgres)', () => {
  const env = parseEnv({ NODE_ENV: 'test' });
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
    accountId = await seedAccount(t.db);
    // A key with a single allow-listed origin.
    await seedApiKey(t.db, accountId, KEY, {
      allowedOrigins: ['https://app.example.com'],
    });
    app = await buildApp(env, { db: t.db, closeDb: async () => {} });
  });
  afterEach(async () => {
    await app.close();
  });

  const req = (headers: Record<string, string>) =>
    app.inject({
      method: 'GET',
      url: '/v1/sdk/eligibility',
      query: { event_name: 'checkout_completed', user_id: 'u_origin' },
      headers: { 'x-signal-app-key': KEY, ...headers },
    });

  it('a disallowed Origin → 403 origin_not_allowed', async () => {
    const res = await req({ origin: 'https://evil.example.com' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('origin_not_allowed');
  });

  it('an allow-listed Origin passes the origin check (→ 204, no workflow)', async () => {
    const res = await req({ origin: 'https://app.example.com' });
    expect(res.statusCode).toBe(204);
  });

  it('NO Origin header (native SDK) passes regardless of the allow-list (→ 204)', async () => {
    const res = await req({});
    expect(res.statusCode).toBe(204);
  });

  it('an empty allow-list means any Origin passes', async () => {
    const openKey = 'pk_test_openoriginsxxxxxxxxx';
    await seedApiKey(t.db, accountId, openKey); // default allowed_origins = []
    const res = await app.inject({
      method: 'GET',
      url: '/v1/sdk/eligibility',
      query: { event_name: 'checkout_completed', user_id: 'u_open' },
      headers: { 'x-signal-app-key': openKey, origin: 'https://anywhere.example.com' },
    });
    expect(res.statusCode).toBe(204);
  });
});
