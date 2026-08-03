import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

/**
 * SDK auth (B1-D4): resolves the `X-Signal-App-Key` publishable key → account_id
 * and exposes it as `request.accountId`. A missing/unknown/revoked key → 401 with
 * the M1-D18 error shape `{ error: { code: 'unauthorized', message } }`.
 *
 * Origin allow-list (B2-D7): each key carries an `allowed_origins` list. It is
 * enforced ONLY when an `Origin` header is present (browsers send one; native
 * SDKs send none and always pass). A present-but-disallowed origin → 403. An
 * empty allow-list means "no browser restriction" (any origin passes).
 *
 * Lookups are cached in-memory with a 60s TTL (mirroring the workflow cache) so
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

export interface ResolvedKey {
  accountId: string;
  allowedOrigins: string[];
}

export type KeyResolver = (key: string) => Promise<ResolvedKey | null>;

const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  resolved: ResolvedKey | null;
  expiresAt: number;
}

export function publishableKeyAuth(
  resolve: KeyResolver,
  opts: { ttlMs?: number; now?: () => number } = {},
): FastifyPluginAsync {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<string, CacheEntry>();

  async function resolveCached(key: string): Promise<ResolvedKey | null> {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.resolved;
    const resolved = await resolve(key);
    cache.set(key, { resolved, expiresAt: now() + ttlMs });
    return resolved;
  }

  return fp(async (app) => {
    app.addHook('onRequest', async (request, reply) => {
      const presented = request.headers['x-signal-app-key'];
      const resolved = typeof presented === 'string' ? await resolveCached(presented) : null;
      if (!resolved) {
        return reply.code(401).send({
          error: { code: 'unauthorized', message: 'missing or invalid X-Signal-App-Key' },
        });
      }

      // Origin allow-list (B2-D7): only enforced when an Origin header is present.
      const origin = request.headers.origin;
      if (typeof origin === 'string' && resolved.allowedOrigins.length > 0) {
        if (!resolved.allowedOrigins.includes(origin)) {
          return reply.code(403).send({
            error: { code: 'origin_not_allowed', message: 'origin is not allow-listed' },
          });
        }
      }

      request.accountId = resolved.accountId;
    });
  });
}
