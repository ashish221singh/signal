import {
  type Target,
  targetCreateSchema,
  targetIntegrationStatusUpdateSchema,
} from '@signal/contracts';
import { asc } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../../db/client.js';
import { targetRegistry } from '../../db/schema.js';
import { TargetService } from '../../targets/service.js';

/**
 * Console target routes (M2, Task 7 list + Task 14 create). Mounted under the
 * guarded `/v1/console` subtree at prefix `/targets`, so every request already
 * has a valid session.
 *
 * Error envelope is `{ error: { code, message } }` (M2-D16).
 */
export function targetRoutes(deps: { db: Db }): FastifyPluginAsync {
  const service = new TargetService(deps.db);
  return async (app) => {
    // POST / — create a target with a server-side slug (Task 14, M2-D13).
    // 422 invalid_body on a bad/blank name or an empty slug; 422 slug_conflict
    // if the derived screen_id already exists (no auto-suffix); 201 otherwise.
    app.post('/', async (request, reply) => {
      const parsed = targetCreateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(422).send({ error: { code: 'invalid_body', message: 'invalid target' } });
      }
      const result = await service.create(parsed.data);
      if (!result.ok) {
        if (result.reason === 'slug_conflict') {
          return reply.code(422).send({
            error: {
              code: 'slug_conflict',
              message: 'a target with this screen_id already exists',
            },
          });
        }
        return reply.code(422).send({
          error: { code: 'invalid_body', message: 'name has no sluggable characters' },
        });
      }
      return reply.code(201).send(result.target);
    });

    // PATCH /:id/integration-status — transition integration_status (Task 15,
    // M2-D17). 422 invalid_body on a bad body; 404 not_found; 422
    // illegal_transition for a move not in the transition table; 200 otherwise.
    app.patch<{ Params: { id: string } }>('/:id/integration-status', async (request, reply) => {
      const parsed = targetIntegrationStatusUpdateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(422)
          .send({ error: { code: 'invalid_body', message: 'invalid integration status' } });
      }
      const result = await service.setIntegrationStatus(request.params.id, parsed.data.to);
      if (result.ok) return reply.send(result.target);
      if (result.reason === 'not_found') {
        return reply.code(404).send({ error: { code: 'not_found', message: 'target not found' } });
      }
      return reply.code(422).send({
        error: {
          code: 'illegal_transition',
          message: 'that integration-status transition is not allowed',
        },
      });
    });

    app.get('/', async () => {
      const rows = await deps.db.select().from(targetRegistry).orderBy(asc(targetRegistry.name));
      return rows.map(
        (r): Target => ({
          id: r.id,
          name: r.name,
          screen_id: r.screenId,
          trigger_mechanism: r.triggerMechanism,
          integration_status: r.integrationStatus,
        }),
      );
    });
  };
}
