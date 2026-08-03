import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

/**
 * SDK auth (B1-D4): resolves the `X-Signal-App-Key` publishable key → account_id
 * and exposes it as `request.accountId`. A missing/unknown/revoked key → 401 with
 * the M1-D18 error shape `{ error: { code: 'unauthorized', message } }`.
 *
 * Lookups are cached in-memory with a 60s TTL (mirroring the campaign cache) so
 * the eligibility hot path does not add a DB round-trip per call. Revoked keys
 * miss the underlying lookup, so within one TTL a revoked key can still resolve —
 * accepted per GR-3 (single/few instances; Redis pub/sub invalidation deferred).
 *
 * Wrapped with `fastify-plugin` (skip-override) so the `onRequest` hook applies
 * to sibling routes registered in the same encapsulated `/v1/sdk` scope. Because
 * that scope is itself encapsulated, the hook does not leak to `/health`.
 */
declare module 'fastify' {
  interface FastifyRequest {
    accountId?: string;
  }
}

export type KeyResolver = (key: string) => Promise<string | null>;

const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  accountId: string | null;
  expiresAt: number;
}

export function publishableKeyAuth(
  resolve: KeyResolver,
  opts: { ttlMs?: number; now?: () => number } = {},
): FastifyPluginAsync {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();

  async function resolveCached(key: string): Promise<string | null> {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.accountId;
    const accountId = await resolve(key);
    cache.set(key, { accountId, expiresAt: now() + ttlMs });
    return accountId;
  }

  return fp(async (app) => {
    app.addHook('onRequest', async (request, reply) => {
      const presented = request.headers['x-signal-app-key'];
      const accountId = typeof presented === 'string' ? await resolveCached(presented) : null;
      if (!accountId) {
        return reply.code(401).send({
          error: { code: 'unauthorized', message: 'missing or invalid X-Signal-App-Key' },
        });
      }
      request.accountId = accountId;
    });
  });
}
