import type { FastifyPluginAsync } from 'fastify';
import { type Clock, systemClock } from '../../clock.js';
import type { Db } from '../../db/client.js';
import { campaignOverview, campaignReasons, dashboardSummary } from '../../reporting/queries.js';

/**
 * Console reporting routes (M2, Tasks 16–17). Mounted (with NO sub-prefix)
 * inside the guarded `/v1/console` subtree, so each route carries its own full
 * path and every request already has a valid session (the guard 401s otherwise).
 *
 * Task 16 defines the campaign Overview; Task 17 adds `GET /dashboard` (the KPIs
 * + attention strip + campaign-health list). The clock is threaded so the
 * dashboard's rolling 30-day window has a deterministic "now" in tests.
 * Error envelope is `{ error: { code, message } }` (M2-D16).
 */
export function reportingRoutes(deps: { db: Db; clock?: Clock }): FastifyPluginAsync {
  const clock = deps.clock ?? systemClock;
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

    // GET /campaigns/:id/reasons — ranked non-null chip selections with shares
    // (M4, Task 2). Unknown campaign → 404 campaign_not_found (M4-D12).
    app.get<{ Params: { id: string } }>('/campaigns/:id/reasons', async (request, reply) => {
      const reasons = await campaignReasons(deps.db, request.params.id);
      if (!reasons) {
        return reply
          .code(404)
          .send({ error: { code: 'campaign_not_found', message: 'no such campaign' } });
      }
      return reply.send(reasons);
    });

    // GET /dashboard — the console landing summary. KPIs over active campaigns
    // and a rolling 30-day window, the 3 attention rules (M2-D11), and the
    // active+paused campaign-health list.
    app.get('/dashboard', async (_request, reply) => {
      const summary = await dashboardSummary(deps.db, clock.now());
      return reply.send(summary);
    });
  };
}
