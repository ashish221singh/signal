import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { readSession } from '../auth/session.js';
import type { Db } from '../db/client.js';
import { consoleUsers } from '../db/schema.js';

/**
 * Console session guard (M2-D2, B1-D5): protects console routes registered as
 * siblings within its encapsulated scope. Reads the signed `signal_session`
 * cookie via `readSession`, then LOADS the console user to resolve the account
 * context — exposing `request.consoleUserId` and `request.accountId`. A missing
 * or invalid cookie, or a stale session whose user no longer exists, → 401.
 *
 * The one select per guarded request that already existed now also yields the
 * account_id, so no extra round-trip is added (B1-D5).
 *
 * Wrapped with `fastify-plugin` (skip-override) so the `onRequest` hook applies
 * to sibling routes in the same scope. Because the outer scope is encapsulated,
 * the hook does not leak to top-level routes such as `/health`.
 *
 * Depends on `@fastify/cookie` being registered with `env.SESSION_SECRET`.
 */
declare module 'fastify' {
  interface FastifyRequest {
    consoleUserId?: string;
    accountId?: string;
  }
}

export function sessionGuard(deps: { db: Db }): FastifyPluginAsync {
  return fp(async (app) => {
    app.addHook('onRequest', async (request, reply) => {
      const userId = readSession(request);
      if (!userId) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'login required' } });
      }
      const [user] = await deps.db
        .select({ id: consoleUsers.id, accountId: consoleUsers.accountId })
        .from(consoleUsers)
        .where(eq(consoleUsers.id, userId))
        .limit(1);
      if (!user) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'stale session' } });
      }
      request.consoleUserId = user.id;
      request.accountId = user.accountId;
    });
  });
}
