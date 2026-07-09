import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

/**
 * SDK auth (M1-D14): rejects requests whose `X-Signal-App-Key` header is
 * missing or not in the set of valid keys. Multiple keys are supported to
 * allow rotation. On failure it replies 401 with the M1-D18 error shape
 * `{ error: { code: 'unauthorized', message } }`.
 *
 * Wrapped with `fastify-plugin` (skip-override) so the `onRequest` hook
 * applies to sibling routes registered in the same scope — e.g. in Task 14
 * where `appKeyAuth` and the SDK routes are registered as siblings inside a
 * single encapsulated `/v1/sdk` scope. Because that outer scope is itself
 * encapsulated, the hook still does not leak to `/health`.
 */
export function appKeyAuth(validKeys: readonly string[]): FastifyPluginAsync {
  const keys = new Set(validKeys);
  return fp(async (app) => {
    app.addHook('onRequest', async (request, reply) => {
      const presented = request.headers['x-signal-app-key'];
      if (typeof presented !== 'string' || !keys.has(presented)) {
        await reply.code(401).send({
          error: { code: 'unauthorized', message: 'missing or invalid X-Signal-App-Key' },
        });
      }
    });
  });
}
