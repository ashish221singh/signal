import { loginRequestSchema } from '@signal/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { verifyPassword } from '../../auth/password.js';
import { clearSession, issueSession, readSession } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { consoleUsers } from '../../db/schema.js';

/**
 * Console auth routes (M2). Mounted under `/v1/console/auth` and NOT behind the
 * session guard — login must be reachable without a session.
 *
 * - No user enumeration (M2): wrong password and unknown email both return the
 *   identical 401 `invalid_credentials` body.
 * - Login is rate-limited 5/min/IP (M2-D4) via per-route `config.rateLimit`; the
 *   `@fastify/rate-limit` plugin is registered globally-disabled in `app.ts`.
 * - Error envelope is `{ error: { code, message } }` (M2-D16).
 */
export function consoleAuthRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    app.post(
      '/login',
      { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const parsed = loginRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply
            .code(422)
            .send({ error: { code: 'invalid_body', message: 'invalid login' } });
        }
        const [user] = await deps.db
          .select()
          .from(consoleUsers)
          .where(eq(consoleUsers.email, parsed.data.email));
        const ok = user ? await verifyPassword(user.passwordHash, parsed.data.password) : false;
        if (!user || !ok) {
          return reply.code(401).send({
            error: { code: 'invalid_credentials', message: 'invalid email or password' },
          });
        }
        issueSession(reply, user.id);
        return reply
          .code(200)
          .send({ id: user.id, email: user.email, name: user.name, role: user.role });
      },
    );

    app.post('/logout', async (_request, reply) => {
      clearSession(reply);
      return reply.code(204).send();
    });

    app.get('/me', async (request, reply) => {
      const userId = readSession(request);
      if (!userId) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'no session' } });
      }
      const [user] = await deps.db.select().from(consoleUsers).where(eq(consoleUsers.id, userId));
      if (!user) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'stale session' } });
      }
      return reply.send({ id: user.id, email: user.email, name: user.name, role: user.role });
    });
  };
}
