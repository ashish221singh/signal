import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../../db/client.js';
import { responses, suppressionState, triggerLog, workflows } from '../../db/schema.js';
import { requireScope } from '../../plugins/resolveAuth.js';

/**
 * User-data deletion (B4-D6, GDPR-lite right-to-be-forgotten). Mounted inside the
 * guarded `/v1/console` subtree, so `request.accountId` is already resolved.
 *
 * `DELETE /v1/console/users/:userId/data` (scope `workflows:write`) transactionally
 * deletes the given `user_id`'s `responses`, `trigger_log`, and `suppression_state`
 * WITHIN the caller's account only — an account can never delete another account's
 * data. Responses FK-reference trigger_log, so responses are deleted first.
 * `suppression_state` has no `account_id`; it is scoped by restricting to the
 * account's own workflow ids. Deleting a user's data re-opens eligibility for that
 * user (correct — they are forgotten). Export is deferred (not v1). Idempotent:
 * a user with no data returns 200 with zero counts.
 */
export function userDataRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    app.delete<{ Params: { userId: string } }>(
      '/users/:userId/data',
      { preHandler: requireScope('workflows:write') },
      async (request, reply) => {
        const accountId = request.accountId as string;
        const { userId } = request.params;

        const deleted = await deps.db.transaction(async (tx) => {
          // The account's own workflow ids — the scope for suppression_state (which
          // has no account_id of its own).
          const accountWorkflows = await tx
            .select({ id: workflows.id })
            .from(workflows)
            .where(eq(workflows.accountId, accountId));
          const workflowIds = accountWorkflows.map((w) => w.id);

          // responses first (they FK-reference trigger_log), both account-scoped.
          const delResponses = await tx
            .delete(responses)
            .where(and(eq(responses.accountId, accountId), eq(responses.userId, userId)))
            .returning({ id: responses.id });

          const delTriggers = await tx
            .delete(triggerLog)
            .where(and(eq(triggerLog.accountId, accountId), eq(triggerLog.userId, userId)))
            .returning({ id: triggerLog.id });

          // suppression_state scoped to the account's workflows only.
          const delSuppression =
            workflowIds.length === 0
              ? []
              : await tx
                  .delete(suppressionState)
                  .where(
                    and(
                      eq(suppressionState.userId, userId),
                      inArray(suppressionState.workflowId, workflowIds),
                    ),
                  )
                  .returning({ workflowId: suppressionState.workflowId });

          return {
            responses: delResponses.length,
            trigger_log: delTriggers.length,
            suppression_state: delSuppression.length,
          };
        });

        return reply.code(200).send({ user_id: userId, deleted });
      },
    );
  };
}
