import { deployRequestSchema } from '@signal/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { Clock } from '../../clock.js';
import type { Db } from '../../db/client.js';
import { DeployService } from '../../deploy/service.js';
import { requireScope } from '../../plugins/resolveAuth.js';

/**
 * config-as-code deploy route (B3-D6, GR-5). Mounted inside the guarded
 * `/v1/console` subtree and gated by the `deploy` scope. Applies a declarative
 * `{ workflows: [...] }` payload with per-item partial-success reporting; a
 * duplicate `key` within the payload is a 422 (the deploy identity must be unique).
 *
 * After a successful apply the SDK workflow cache is refreshed so a just-published
 * workflow is immediately eligible (mirrors the console publish path).
 */
export function deployRoutes(deps: {
  db: Db;
  clock: Clock;
  refreshCache: () => Promise<void>;
}): FastifyPluginAsync {
  const service = new DeployService(deps.db, deps.clock);
  return async (app) => {
    app.post('/deploy', { preHandler: requireScope('deploy') }, async (request, reply) => {
      const parsed = deployRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(422)
          .send({ error: { code: 'invalid_body', message: 'invalid deploy payload' } });
      }
      // Reject duplicate keys within the payload — the upsert identity is `key`.
      const keys = parsed.data.workflows.map((w) => w.key);
      if (new Set(keys).size !== keys.length) {
        return reply
          .code(422)
          .send({ error: { code: 'duplicate_key', message: 'workflow keys must be unique' } });
      }

      const results = await service.deploy(request.accountId as string, parsed.data);
      await deps.refreshCache();
      return reply.send({ results });
    });
  };
}
