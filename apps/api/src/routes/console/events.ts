import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../../db/client.js';
import { listSeenEvents } from '../../events/repo.js';
import { requireScope } from '../../plugins/resolveAuth.js';

/**
 * Event surfacing read route (B3-D7). `GET /v1/console/events` lists the events an
 * account has fired eligibility checks for (populated off the hot path by the
 * eligibility service's first-sighting upsert). Account-scoped; `workflows:read`.
 */
export function eventRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    app.get('/events', { preHandler: requireScope('workflows:read') }, async (request, reply) => {
      const events = await listSeenEvents(deps.db, request.accountId as string);
      return reply.send({ events });
    });
  };
}
