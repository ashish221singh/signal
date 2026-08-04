import { responseFeedQuerySchema } from '@signal/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { type Clock, systemClock } from '../../clock.js';
import type { Db } from '../../db/client.js';
import { requireScope } from '../../plugins/resolveAuth.js';
import {
  campaignOverview,
  campaignReasons,
  campaignResponses,
  campaignTrend,
  dashboardSummary,
  eventsOverview,
} from '../../reporting/queries.js';

/**
 * Console reporting routes (M2, Tasks 16–17). Mounted (with NO sub-prefix)
 * inside the guarded `/v1/console` subtree, so each route carries its own full
 * path and every request already has a valid session (the guard 401s otherwise).
 *
 * Task 16 defines the campaign Overview; Task 17 adds `GET /dashboard` (the KPIs
 * + attention strip + campaign-health list). The clock is threaded so the
 * dashboard's rolling 30-day window has a deterministic "now" in tests.
 * Error envelope is `{ error: { code, message } }` (M2-D16).
 *
 * B4-D5: every reporting route requires the `responses:read` scope, so a CLI/MCP
 * token can read reports (the unified auth accepts session OR token). A session
 * carries all scopes and always passes; a token missing `responses:read` → 403.
 */
export function reportingRoutes(deps: { db: Db; clock?: Clock }): FastifyPluginAsync {
  const clock = deps.clock ?? systemClock;
  const read = { preHandler: requireScope('responses:read') };
  return async (app) => {
    // GET /workflows/:id/overview — trigger/response counts + derived ratios.
    // A distinct, more-specific path than workflowRoutes' /workflows/:id, so the
    // two encapsulated plugins don't collide.
    app.get<{ Params: { id: string } }>('/workflows/:id/overview', read, async (request, reply) => {
      const overview = await campaignOverview(
        deps.db,
        request.accountId as string,
        request.params.id,
      );
      if (!overview) {
        return reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'campaign not found' } });
      }
      return reply.send(overview);
    });

    // GET /campaigns/:id/reasons — ranked non-null chip selections with shares
    // (M4, Task 2). Unknown campaign → 404 campaign_not_found (M4-D12).
    app.get<{ Params: { id: string } }>('/workflows/:id/reasons', read, async (request, reply) => {
      const reasons = await campaignReasons(
        deps.db,
        request.accountId as string,
        request.params.id,
      );
      if (!reasons) {
        return reply
          .code(404)
          .send({ error: { code: 'campaign_not_found', message: 'no such campaign' } });
      }
      return reply.send(reasons);
    });

    // GET /campaigns/:id/responses — cursor-paginated, newest-first response
    // drill-down for the Responses tab (M4, Task 4), filterable by an inclusive
    // score band. Bad query → 422 invalid_query; unknown campaign → 404 (M4-D12).
    app.get<{ Params: { id: string } }>(
      '/workflows/:id/responses',
      read,
      async (request, reply) => {
        const parsed = responseFeedQuerySchema.safeParse(request.query);
        if (!parsed.success) {
          return reply.code(422).send({
            error: { code: 'invalid_query', message: parsed.error.issues[0]?.message ?? 'invalid' },
          });
        }
        const feed = await campaignResponses(
          deps.db,
          request.accountId as string,
          request.params.id,
          {
            minRating: parsed.data.min_rating,
            maxRating: parsed.data.max_rating,
            cursor: parsed.data.cursor,
            limit: parsed.data.limit,
          },
        );
        if (!feed) {
          return reply
            .code(404)
            .send({ error: { code: 'campaign_not_found', message: 'no such campaign' } });
        }
        return reply.send(feed);
      },
    );

    // GET /campaigns/:id/trend — 30-day per-UTC-day positive-score trend for the
    // Trend tab (M4, Task 5). Uses the same threaded clock as /dashboard so the
    // rolling window has a deterministic "now". Unknown campaign → 404 (M4-D12).
    app.get<{ Params: { id: string } }>('/workflows/:id/trend', read, async (request, reply) => {
      const trend = await campaignTrend(
        deps.db,
        request.accountId as string,
        request.params.id,
        clock.now(),
      );
      if (!trend) {
        return reply
          .code(404)
          .send({ error: { code: 'campaign_not_found', message: 'no such campaign' } });
      }
      return reply.send(trend);
    });

    // GET /dashboard — the console landing summary. KPIs over active campaigns
    // and a rolling 30-day window, the 3 attention rules (M2-D11), and the
    // active+paused campaign-health list.
    app.get('/dashboard', read, async (request, reply) => {
      const summary = await dashboardSummary(deps.db, request.accountId as string, clock.now());
      return reply.send(summary);
    });

    // GET /events/overview — account-wide triggers/responses rolled up per
    // `event_name` (B4-D5). Distinct path from eventRoutes' `/events`.
    app.get('/events/overview', read, async (request, reply) => {
      const events = await eventsOverview(deps.db, request.accountId as string);
      return reply.send({ events });
    });
  };
}
