import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishableKeyAuth, type ResolvedKey } from './publishableKeyAuth.js';

const ACCOUNT = 'acc-123';
const resolved = (allowedOrigins: string[] = []): ResolvedKey => ({
  accountId: ACCOUNT,
  allowedOrigins,
});

describe('publishableKeyAuth plugin', () => {
  let app: ReturnType<typeof Fastify>;

  afterEach(async () => {
    if (app) await app.close();
  });

  async function buildWith(resolve: Parameters<typeof publishableKeyAuth>[0], opts = {}) {
    app = Fastify({ logger: false });
    await app.register(async (scope: FastifyInstance) => {
      await scope.register(publishableKeyAuth(resolve, opts));
      scope.get('/protected', async (request) => ({ accountId: request.accountId }));
    });
    app.get('/open', async () => ({ open: true }));
    await app.ready();
  }

  it('rejects a request with no app key (401 unauthorized)', async () => {
    await buildWith(async () => resolved());
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('rejects an unknown/revoked key (resolver returns null → 401)', async () => {
    await buildWith(async () => null);
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-signal-app-key': 'pk_live_bad' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid key and sets request.accountId', async () => {
    await buildWith(async () => resolved());
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-signal-app-key': 'pk_live_good' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accountId: ACCOUNT });
  });

  it('caches lookups within the TTL, then re-resolves after it expires', async () => {
    let clock = 1_000;
    const resolve = vi.fn(async () => resolved());
    await buildWith(resolve, { ttlMs: 60_000, now: () => clock });

    const hit = () =>
      app.inject({
        method: 'GET',
        url: '/protected',
        headers: { 'x-signal-app-key': 'pk_live_good' },
      });

    await hit();
    await hit();
    expect(resolve).toHaveBeenCalledTimes(1); // second call served from cache

    clock += 61_000; // TTL expired
    await hit();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('does not leak auth to sibling top-level routes', async () => {
    await buildWith(async () => resolved());
    const res = await app.inject({ method: 'GET', url: '/open' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ open: true });
  });

  describe('origin allow-list (B2-D7)', () => {
    it('no Origin header → passes even with a non-empty allow-list', async () => {
      await buildWith(async () => resolved(['https://app.example.com']));
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { 'x-signal-app-key': 'pk_live_good' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('a disallowed Origin → 403 origin_not_allowed', async () => {
      await buildWith(async () => resolved(['https://app.example.com']));
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { 'x-signal-app-key': 'pk_live_good', origin: 'https://evil.example.com' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('origin_not_allowed');
    });

    it('an allow-listed Origin → passes', async () => {
      await buildWith(async () => resolved(['https://app.example.com']));
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { 'x-signal-app-key': 'pk_live_good', origin: 'https://app.example.com' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('an empty allow-list → any Origin passes', async () => {
      await buildWith(async () => resolved([]));
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { 'x-signal-app-key': 'pk_live_good', origin: 'https://anywhere.example.com' },
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
