import { workflowDraftCreateSchema, workflowUpdateSchema } from '@signal/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { Clock } from '../../clock.js';
import type { Db } from '../../db/client.js';
import { WorkflowService } from '../../workflows/service.js';

/**
 * Console workflow CRUD routes (B2, was campaigns). Mounted under the guarded
 * `/v1/console` subtree at prefix `/workflows`, so every request already has a
 * valid session and `request.consoleUserId`/`request.accountId` set by the guard.
 *
 * Error envelope is `{ error: { code, message } }` (M2-D16).
 */
export function workflowRoutes(deps: { db: Db; clock: Clock }): FastifyPluginAsync {
  const service = new WorkflowService(deps.db, deps.clock);
  return async (app) => {
    // POST / — create a draft owned by the authenticated PM.
    app.post('/', async (request, reply) => {
      const parsed = workflowDraftCreateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(422)
          .send({ error: { code: 'invalid_body', message: 'invalid workflow draft' } });
      }
      const accountId = request.accountId;
      if (!accountId) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'login required' } });
      }
      // Session requests carry a console user; token requests do not — stamp a
      // token marker so `created_by` is always populated (B3-D5).
      const createdBy = request.consoleUserId ?? 'cli-token';
      const workflow = await service.create(accountId, createdBy, parsed.data);
      return reply.code(201).send(workflow);
    });

    // GET /:id — the full workflow, or 404.
    app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
      const workflow = await service.getById(request.accountId as string, request.params.id);
      if (!workflow) {
        return reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'workflow not found' } });
      }
      return reply.send(workflow);
    });

    // PATCH /:id — partial update of a draft's builder fields. Semantic fields
    // (incl. `event_name`, B2) lock to 422 semantic_locked once the workflow has
    // ≥1 response.
    app.patch<{ Params: { id: string } }>('/:id', async (request, reply) => {
      const parsed = workflowUpdateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(422)
          .send({ error: { code: 'invalid_body', message: 'invalid workflow update' } });
      }
      const result = await service.update(
        request.accountId as string,
        request.params.id,
        parsed.data,
      );
      if (!result.ok) {
        if (result.reason === 'not_found') {
          return reply
            .code(404)
            .send({ error: { code: 'not_found', message: 'workflow not found' } });
        }
        return reply.code(422).send({
          error: {
            code: 'semantic_locked',
            message: 'semantic fields are locked once the workflow has responses',
          },
        });
      }
      return reply.send(result.workflow);
    });

    // POST /:id/publish — flip a complete, non-overlapping draft to active.
    // Completeness failures return 422 `incomplete` with a top-level `missing: [...]`;
    // an active `event_name` collision returns 409 `overlap` with a top-level
    // `conflict: { id, header, event_name }`.
    app.post<{ Params: { id: string } }>('/:id/publish', async (request, reply) => {
      const result = await service.publish(request.accountId as string, request.params.id);
      if (result.ok) return reply.send(result.workflow);
      if (result.reason === 'not_found') {
        return reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'workflow not found' } });
      }
      if (result.reason === 'incomplete') {
        return reply.code(422).send({
          error: { code: 'incomplete', message: 'workflow is missing required fields to publish' },
          missing: result.missing,
        });
      }
      // overlap (B2-D3): one active workflow per (account, event_name).
      return reply.code(409).send({
        error: {
          code: 'overlap',
          message: 'another active workflow already listens for this event',
        },
        conflict: result.conflict,
      });
    });

    // POST /:id/pause — active → paused. 404 not_found; 409 invalid_state.
    app.post<{ Params: { id: string } }>('/:id/pause', async (request, reply) => {
      const result = await service.pause(request.accountId as string, request.params.id);
      if (result.ok) return reply.send(result.workflow);
      if (result.reason === 'not_found') {
        return reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'workflow not found' } });
      }
      return reply.code(409).send({
        error: { code: 'invalid_state', message: 'only an active workflow can be paused' },
      });
    });

    // POST /:id/resume — paused → active, re-running the overlap check.
    // 404 not_found; 409 invalid_state; 409 overlap (with `conflict`) on a clash.
    app.post<{ Params: { id: string } }>('/:id/resume', async (request, reply) => {
      const result = await service.resume(request.accountId as string, request.params.id);
      if (result.ok) return reply.send(result.workflow);
      if (result.reason === 'not_found') {
        return reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'workflow not found' } });
      }
      if (result.reason === 'overlap') {
        return reply.code(409).send({
          error: {
            code: 'overlap',
            message: 'another active workflow already listens for this event',
          },
          conflict: result.conflict,
        });
      }
      return reply.code(409).send({
        error: { code: 'invalid_state', message: 'only a paused workflow can be resumed' },
      });
    });

    // POST /:id/archive — any non-archived state → archived (M2-D6).
    app.post<{ Params: { id: string } }>('/:id/archive', async (request, reply) => {
      const result = await service.archive(request.accountId as string, request.params.id);
      if (result.ok) return reply.send(result.workflow);
      if (result.reason === 'not_found') {
        return reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'workflow not found' } });
      }
      return reply
        .code(409)
        .send({ error: { code: 'invalid_state', message: 'workflow is already archived' } });
    });

    // DELETE /:id — safe hard delete (M2-D6). 204 only for a draft with zero
    // trigger/response history; otherwise 409 has_history ("archive instead").
    app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
      const result = await service.remove(request.accountId as string, request.params.id);
      if (result.ok) return reply.code(204).send();
      if (result.reason === 'not_found') {
        return reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'workflow not found' } });
      }
      return reply.code(409).send({ error: { code: 'has_history', message: 'archive instead' } });
    });

    // GET / — list projection; archived excluded unless ?include=archived (M2-D6).
    app.get<{ Querystring: { include?: string } }>('/', async (request, reply) => {
      const includeArchived = request.query.include === 'archived';
      const rows = await service.list(request.accountId as string, { includeArchived });
      return reply.send(rows);
    });
  };
}
