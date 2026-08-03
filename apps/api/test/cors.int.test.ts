import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/env.js';
import { seedAccount, seedApiKey, startTestDb } from './testDb.js';

/**
 * CORS split (B4-D2): `/v1/console/*` allows the dashboard origins from
 * `CONSOLE_ORIGINS` with credentials; `/v1/sdk/*` reflects an allowed `Origin`
 * per the calling account's `allowed_origins`; `/cli/*` (root) emits no CORS.
 */
const DASHBOARD_ORIGIN = 'https://dashboard.example';
const OTHER_ORIGIN = 'https://evil.example';
const SDK_ORIGIN = 'https://app.customer.example';
const APP_KEY = 'pk_test_corsxxxxxxxxxxxxxxxxxx';

const env = parseEnv({ NODE_ENV: 'test', CONSOLE_ORIGINS: `${DASHBOARD_ORIGIN},https://other.ok` });

describe('CORS (real Postgres)', () => {
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

  describe('console surface', () => {
    it('allows a configured dashboard origin WITH credentials (preflight)', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/v1/console/dashboard',
        headers: {
          origin: DASHBOARD_ORIGIN,
          'access-control-request-method': 'GET',
        },
      });
      expect(res.headers['access-control-allow-origin']).toBe(DASHBOARD_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('reflects the dashboard origin on the actual (unauthenticated) response too', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/console/dashboard',
        headers: { origin: DASHBOARD_ORIGIN },
      });
      // Even though the request is 401 (no session), the CORS header is present so
      // the browser can read the error.
      expect(res.statusCode).toBe(401);
      expect(res.headers['access-control-allow-origin']).toBe(DASHBOARD_ORIGIN);
    });

    it('blocks a non-allow-listed origin (no ACAO header)', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/v1/console/dashboard',
        headers: { origin: OTHER_ORIGIN, 'access-control-request-method': 'GET' },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('also protects the /v1/console/auth login subtree', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/v1/console/auth/login',
        headers: { origin: DASHBOARD_ORIGIN, 'access-control-request-method': 'POST' },
      });
      expect(res.headers['access-control-allow-origin']).toBe(DASHBOARD_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });
  });

  describe('sdk surface', () => {
    it("reflects an origin that is on the account's allow-list", async () => {
      const accountId = await seedAccount(t.db);
      await seedApiKey(t.db, accountId, APP_KEY, { allowedOrigins: [SDK_ORIGIN] });
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/v1/sdk/eligibility',
        headers: {
          origin: SDK_ORIGIN,
          'x-signal-app-key': APP_KEY,
          'access-control-request-method': 'GET',
        },
      });
      expect(res.headers['access-control-allow-origin']).toBe(SDK_ORIGIN);
    });

    it("does NOT reflect an origin absent from the account's allow-list", async () => {
      const accountId = await seedAccount(t.db);
      await seedApiKey(t.db, accountId, APP_KEY, { allowedOrigins: [SDK_ORIGIN] });
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/v1/sdk/eligibility',
        headers: {
          origin: OTHER_ORIGIN,
          'x-signal-app-key': APP_KEY,
          'access-control-request-method': 'GET',
        },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('an empty account allow-list reflects ANY origin (no browser restriction)', async () => {
      const accountId = await seedAccount(t.db);
      await seedApiKey(t.db, accountId, APP_KEY, { allowedOrigins: [] });
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/v1/sdk/eligibility',
        headers: {
          origin: OTHER_ORIGIN,
          'x-signal-app-key': APP_KEY,
          'access-control-request-method': 'GET',
        },
      });
      expect(res.headers['access-control-allow-origin']).toBe(OTHER_ORIGIN);
    });

    it('emits no CORS header when the app key is missing', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/v1/sdk/eligibility',
        headers: { origin: SDK_ORIGIN, 'access-control-request-method': 'GET' },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('cli / root surface', () => {
    it('emits no CORS header on /v1/cli/device/code', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/v1/cli/device/code',
        headers: { origin: DASHBOARD_ORIGIN, 'access-control-request-method': 'POST' },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
