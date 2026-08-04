import {
  type ApiKey,
  apiKeyCreateSchema,
  type CliToken,
  cliTokenCreateSchema,
} from '@signal/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { AccountsService, type IssueKeyResult } from '../../accounts/service.js';
import type { Db } from '../../db/client.js';
import { requireScope } from '../../plugins/resolveAuth.js';
import type { TokenService } from '../../tokens/service.js';

/**
 * Key & CLI-token management (B3, Task 6). Mounted inside the guarded `/v1/console`
 * subtree, so every request already carries `request.accountId` from `resolveAuth`.
 * All queries are account-scoped (isolation — A can't see or revoke B's keys/tokens).
 *
 * Publishable keys are NOT secrets, so their plaintext is returned on list. CLI
 * tokens ARE secrets: the plaintext appears ONLY in the create response, never on
 * list. Token mutation requires the `workflows:write` scope (a read-only token
 * cannot mint or revoke tokens/keys); reads require `workflows:read`.
 */
function toApiKey(r: IssueKeyResult): ApiKey {
  return {
    id: r.id,
    key: r.key,
    label: r.label,
    environment: r.environment,
    allowed_origins: r.allowedOrigins,
    created_at: r.createdAt,
    revoked_at: r.revokedAt,
  };
}

export function managementRoutes(deps: { db: Db; tokens: TokenService }): FastifyPluginAsync {
  const accounts = new AccountsService(deps.db);
  const { tokens } = deps;

  return async (app) => {
    // ── Publishable keys ──
    app.get('/keys', { preHandler: requireScope('workflows:read') }, async (request, reply) => {
      const rows = await accounts.listKeys(request.accountId as string);
      return reply.send({ keys: rows.map(toApiKey) });
    });

    app.post('/keys', { preHandler: requireScope('workflows:write') }, async (request, reply) => {
      const parsed = apiKeyCreateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(422).send({ error: { code: 'invalid_body', message: 'invalid key' } });
      }
      const row = await accounts.createKey(request.accountId as string, {
        label: parsed.data.label,
        environment: parsed.data.environment,
        allowedOrigins: parsed.data.allowed_origins,
      });
      return reply.code(201).send(toApiKey(row));
    });

    app.delete<{ Params: { id: string } }>(
      '/keys/:id',
      { preHandler: requireScope('workflows:write') },
      async (request, reply) => {
        const ok = await accounts.revokeKeyById(request.accountId as string, request.params.id);
        if (!ok) {
          return reply.code(404).send({ error: { code: 'not_found', message: 'key not found' } });
        }
        return reply.code(204).send();
      },
    );

    // ── CLI tokens ──
    app.get(
      '/cli-tokens',
      { preHandler: requireScope('workflows:read') },
      async (request, reply) => {
        const rows: CliToken[] = await tokens.list(request.accountId as string);
        return reply.send({ tokens: rows });
      },
    );

    app.post(
      '/cli-tokens',
      { preHandler: requireScope('workflows:write') },
      async (request, reply) => {
        const parsed = cliTokenCreateSchema.safeParse(request.body ?? {});
        if (!parsed.success) {
          return reply
            .code(422)
            .send({ error: { code: 'invalid_body', message: 'invalid token request' } });
        }
        const { token, meta } = await tokens.issue(request.accountId as string, parsed.data.name, {
          scopes: parsed.data.scopes,
        });
        return reply.code(201).send({ ...meta, token });
      },
    );

    app.delete<{ Params: { id: string } }>(
      '/cli-tokens/:id',
      { preHandler: requireScope('workflows:write') },
      async (request, reply) => {
        const ok = await tokens.revoke(request.accountId as string, request.params.id);
        if (!ok) {
          return reply.code(404).send({ error: { code: 'not_found', message: 'token not found' } });
        }
        return reply.code(204).send();
      },
    );
  };
}
