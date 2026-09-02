import type { FastifyPluginAsync } from 'fastify';
import type { DeviceService } from '../../cli/deviceService.js';
import { requireScope } from '../../plugins/resolveAuth.js';

/**
 * Clerk-authed device approval (F4). The dashboard SPA (`/app/cli/approve`, behind
 * RequireAuth → Clerk) posts here to approve/deny a CLI device grant. Because it runs
 * inside the guarded `/v1/console` subtree, `request.accountId` is the SAME account
 * the dashboard resolves for the Clerk user — so `signal connect`/`quickstart` bind
 * the CLI token to the account you actually see in the dashboard (fixes the old
 * server-rendered `/login` device flow, which used the legacy password identity).
 *
 * Shares the one `DeviceService` instance with `/v1/cli/*` (its `pendingTokens` map
 * is in-memory) so the CLI's poll picks up the freshly minted token.
 */
export function cliApproveRoutes(deps: { devices: DeviceService }): FastifyPluginAsync {
  return async (app) => {
    app.post<{ Body: { user_code?: string; decision?: string } }>(
      '/cli/approve',
      { preHandler: requireScope('workflows:write') },
      async (request, reply) => {
        const body = request.body ?? {};
        const userCode = typeof body.user_code === 'string' ? body.user_code.trim() : '';
        if (!userCode) {
          return reply
            .code(400)
            .send({ error: { code: 'invalid_body', message: 'user_code is required' } });
        }

        if (body.decision === 'deny') {
          const denied = await deps.devices.deny(userCode);
          return reply.send({ status: denied ? 'denied' : 'invalid' });
        }

        const ok = await deps.devices.approve(userCode, request.accountId as string);
        return reply.code(ok ? 200 : 400).send({ status: ok ? 'approved' : 'invalid' });
      },
    );
  };
}
