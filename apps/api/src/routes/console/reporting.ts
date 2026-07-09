import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../../db/client.js';
import { campaignOverview } from '../../reporting/queries.js';

/**
 * Console reporting routes (M2, Task 16). Mounted (with NO sub-prefix) inside
 * the guarded `/v1/console` subtree, so each route carries its own full path and
 * every request already has a valid session (the guard 401s otherwise).
 *
 * Task 16 defines only the campaign Overview. Task 17 will add `GET /dashboard`
 * to this same factory. Error envelope is `{ error: { code, message } }` (M2-D16).
 */
export function reportingRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    // GET /campaigns/:id/overview — trigger/response counts + derived ratios.
    // A distinct, more-specific path than campaignRoutes' /campaigns/:id, so the
    // two encapsulated plugins don't collide.
    app.get<{ Params: { id: string } }>('/campaigns/:id/overview', async (request, reply) => {
      const overview = await campaignOverview(deps.db, request.params.id);
      if (!overview) {
        return reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'campaign not found' } });
      }
      return reply.send(overview);
    });
  };
}
