import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Serve the built dashboard SPA (@signal/dashboard) same-origin under `/app` (F3).
 * Serving it from the API origin means the session cookie and the Google OAuth
 * callback redirect (`next=/app/dashboard`) all stay same-origin — no CORS/cookie
 * dance. Encapsulated so the SPA-fallback not-found handler is scoped to `/app`
 * only and never changes the API's JSON 404s elsewhere.
 *
 * Registration is skipped when `distDir` is absent (e.g. the dashboard hasn't been
 * built, as in the API test suite), so the API still boots.
 */
export function dashboardStaticPlugin(distDir: string): FastifyPluginAsync {
  return async (app) => {
    if (!existsSync(distDir)) {
      app.log.warn({ distDir }, 'dashboard dist not found — skipping /app static serving');
      return;
    }
    await app.register(
      async (scope) => {
        await scope.register(fastifyStatic, { root: distDir });
        // Client-side routes (/app/dashboard, /app/settings, …) have no file on
        // disk → serve the SPA shell so the router can take over.
        scope.setNotFoundHandler((_req, reply) => reply.sendFile('index.html'));
      },
      { prefix: '/app' },
    );
  };
}
