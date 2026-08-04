import { previewRequestSchema } from '@signal/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { Clock } from '../../clock.js';
import type { Db } from '../../db/client.js';
import type { Env } from '../../env.js';
import { requireScope } from '../../plugins/resolveAuth.js';
import { mintPreviewToken, PREVIEW_TTL_SECONDS } from '../../preview/token.js';
import { WorkflowService } from '../../workflows/service.js';

/**
 * Hosted-link preview minting (F2-D7, F2-D16). `POST /v1/console/preview` — auth via
 * the console session OR a CLI token carrying `workflows:read` — validates that the
 * `workflow_id` belongs to the caller's account, then mints a short-lived
 * (~30 min) HMAC-signed preview token and returns the shareable `/s/preview/:token`
 * URL. No DB row: the token is the stateless grant (preview never persists).
 */
export function previewRoutes(deps: { db: Db; clock: Clock; env: Env }): FastifyPluginAsync {
  const service = new WorkflowService(deps.db, deps.clock);
  return async (app) => {
    app.post('/preview', { preHandler: requireScope('workflows:read') }, async (request, reply) => {
      const parsed = previewRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(422)
          .send({ error: { code: 'invalid_body', message: 'workflow_id is required' } });
      }
      const accountId = request.accountId as string;
      // Account isolation (B1-D8): only a workflow in the caller's account is
      // previewable — otherwise 404, never leaking another account's ids.
      const workflow = await service.getById(accountId, parsed.data.workflow_id);
      if (!workflow) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'no such workflow' } });
      }
      const { token, expiresAt } = mintPreviewToken(
        { account_id: accountId, workflow_id: workflow.id },
        deps.env.SESSION_SECRET,
        PREVIEW_TTL_SECONDS,
        deps.clock.now().getTime(),
      );
      const base = deps.env.PUBLIC_BASE_URL.replace(/\/$/, '');
      return reply.code(201).send({
        token,
        preview_url: `${base}/s/preview/${token}`,
        expires_at: expiresAt.toISOString(),
      });
    });
  };
}
