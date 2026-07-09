import { campaignDraftCreateSchema, campaignUpdateSchema } from '@signal/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { CampaignService } from '../../campaigns/service.js';
import type { Clock } from '../../clock.js';
import type { Db } from '../../db/client.js';

/**
 * Console campaign CRUD routes (M2, Task 10). Mounted under the guarded
 * `/v1/console` subtree at prefix `/campaigns`, so every request already has a
 * valid session and `request.consoleUserId` set by the guard.
 *
 * Task 10 covers create (draft) / get / list only. Update (Task 11), publish
 * (Task 12) and lifecycle (Task 13) extend this file and the service later.
 *
 * Error envelope is `{ error: { code, message } }` (M2-D16).
 */
export function campaignRoutes(deps: { db: Db; clock: Clock }): FastifyPluginAsync {
  const service = new CampaignService(deps.db, deps.clock);
  return async (app) => {
    // POST / — create a draft owned by the authenticated PM (M2-D18).
    app.post('/', async (request, reply) => {
      const parsed = campaignDraftCreateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(422)
          .send({ error: { code: 'invalid_body', message: 'invalid campaign draft' } });
      }
      // `consoleUserId` is guaranteed set by the session guard on this subtree;
      // the guard 401s before the handler runs otherwise, so this never throws.
      const createdBy = request.consoleUserId;
      if (!createdBy) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'login required' } });
      }
      const campaign = await service.create(createdBy, parsed.data);
      return reply.code(201).send(campaign);
    });

    // GET /:id — the full campaign, or 404.
    app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
      const campaign = await service.getById(request.params.id);
      if (!campaign) {
        return reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'campaign not found' } });
      }
      return reply.send(campaign);
    });

    // PATCH /:id — partial update of a draft's builder fields (Task 11). Semantic
    // fields (M2-D9) lock to 422 semantic_locked once the campaign has ≥1 response.
    app.patch<{ Params: { id: string } }>('/:id', async (request, reply) => {
      const parsed = campaignUpdateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(422)
          .send({ error: { code: 'invalid_body', message: 'invalid campaign update' } });
      }
      const result = await service.update(request.params.id, parsed.data);
      if (!result.ok) {
        if (result.reason === 'not_found') {
          return reply
            .code(404)
            .send({ error: { code: 'not_found', message: 'campaign not found' } });
        }
        return reply.code(422).send({
          error: {
            code: 'semantic_locked',
            message: 'semantic fields are locked once the campaign has responses',
          },
        });
      }
      return reply.send(result.campaign);
    });

    // POST /:id/publish — flip a complete, non-overlapping draft to active (Task 12).
    // Completeness failures return 422 `incomplete` with a top-level `missing: [...]`;
    // an active (target, client) collision returns 409 `overlap` with a top-level
    // `conflict: { id, header }` (both carried ALONGSIDE the standard error envelope).
    app.post<{ Params: { id: string } }>('/:id/publish', async (request, reply) => {
      const result = await service.publish(request.params.id);
      if (result.ok) return reply.send(result.campaign);
      if (result.reason === 'not_found') {
        return reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'campaign not found' } });
      }
      if (result.reason === 'incomplete') {
        return reply.code(422).send({
          error: { code: 'incomplete', message: 'campaign is missing required fields to publish' },
          missing: result.missing,
        });
      }
      // overlap (M2-D8): one active campaign per (target, client).
      return reply.code(409).send({
        error: {
          code: 'overlap',
          message: 'another active campaign already targets an overlapping client',
        },
        conflict: result.conflict,
      });
    });

    // GET / — list projection; archived excluded unless ?include=archived (M2-D6).
    app.get<{ Querystring: { include?: string } }>('/', async (request, reply) => {
      const includeArchived = request.query.include === 'archived';
      const rows = await service.list({ includeArchived });
      return reply.send(rows);
    });
  };
}
