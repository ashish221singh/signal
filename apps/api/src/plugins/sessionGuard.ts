import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { readSession } from '../auth/session.js';

/**
 * Console session guard (M2-D2): protects console routes registered as siblings
 * within its encapsulated scope. Reads the signed `signal_session` cookie via
 * `readSession` (which uses `request.unsignCookie`), and on success exposes the
 * console user's id as `request.consoleUserId`. On a missing/invalid cookie it
 * replies 401 with the M2-D16 error envelope `{ error: { code, message } }`.
 *
 * Wrapped with `fastify-plugin` (skip-override) — mirroring `appKeyAuth` — so
 * the `onRequest` hook applies to sibling routes in the same scope. Task 7
 * mounts the console subtree (targets/clients routes) as siblings of this guard
 * inside a single encapsulated scope, so the hook must not be confined to the
 * guard's own child scope. Because that outer scope is encapsulated, the hook
 * still does not leak to top-level routes such as `/health`.
 *
 * Depends on `@fastify/cookie` being registered with `env.SESSION_SECRET` on the
 * app instance this guard runs under.
 */
declare module 'fastify' {
  interface FastifyRequest {
    consoleUserId?: string;
  }
}

export const sessionGuard: FastifyPluginAsync = fp(async (app) => {
  app.addHook('onRequest', async (request, reply) => {
    const userId = readSession(request);
    if (!userId) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'login required' } });
    }
    request.consoleUserId = userId;
  });
});
