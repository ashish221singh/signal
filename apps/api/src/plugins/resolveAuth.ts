import { ALL_CLI_SCOPES, type CliScope } from '@signal/contracts';
import { eq } from 'drizzle-orm';
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import fp from 'fastify-plugin';
import type { AccountsService } from '../accounts/service.js';
import type { ClerkAuth } from '../auth/clerk.js';
import { readSession } from '../auth/session.js';
import type { Db } from '../db/client.js';
import { consoleUsers } from '../db/schema.js';
import type { TokenService } from '../tokens/service.js';

/**
 * Unified auth (B3-D5, GR-4): the single authorization model for `/v1/console/*`.
 * REPLACES B1's `sessionGuard` — a request may carry EITHER
 *   1. the signed `signal_session` cookie (a console user) ⇒ ALL scopes, or
 *   2. `Authorization: Bearer cli_…` (a CLI token) ⇒ the token's scopes.
 * Either resolves to `request.auth = { accountId, scopes, via }`. A missing/invalid
 * credential → 401. MCP and CLI hit the same endpoints humans do (B3-D5).
 *
 * For backward compatibility with B1/B2 routes, `request.accountId` is still set,
 * and `request.consoleUserId` is set on the session path only (token requests have
 * no console user — `createdBy` falls back to a token marker in those routes).
 *
 * `requireScope(scope)` is a per-route preHandler that 403s when the resolved auth
 * lacks the scope. Session auth carries all scopes, so it always passes.
 */
export interface RequestAuth {
  accountId: string;
  scopes: CliScope[];
  via: 'session' | 'token';
}

declare module 'fastify' {
  interface FastifyRequest {
    // `accountId` is also declared by publishableKeyAuth (the SDK path); declaring
    // it again here is a harmless interface merge. `consoleUserId` is set on the
    // session path only. `auth` is the unified context (B3-D5).
    consoleUserId?: string;
    auth?: RequestAuth;
  }
}

const BEARER_PREFIX = 'Bearer ';

export function resolveAuth(deps: {
  db: Db;
  tokens: TokenService;
  clerk?: ClerkAuth;
  accounts?: AccountsService;
}): FastifyPluginAsync {
  return fp(async (app) => {
    app.addHook('onRequest', async (request, reply) => {
      const authHeader = request.headers.authorization;

      if (typeof authHeader === 'string' && authHeader.startsWith(BEARER_PREFIX)) {
        const token = authHeader.slice(BEARER_PREFIX.length).trim();

        // 1a) CLI token (`cli_…`) ⇒ the token's scopes.
        if (token.startsWith('cli_')) {
          const resolved = await deps.tokens.verify(token);
          if (!resolved) {
            return reply
              .code(401)
              .send({ error: { code: 'unauthorized', message: 'invalid or expired token' } });
          }
          request.auth = { accountId: resolved.accountId, scopes: resolved.scopes, via: 'token' };
          request.accountId = resolved.accountId;
          return;
        }

        // 1b) Clerk session JWT (the dashboard) ⇒ all scopes. Verify → map the Clerk
        // user to a Signal account (find-or-create, fetching email from Clerk once).
        if (deps.clerk && deps.accounts) {
          const clerkUserId = await deps.clerk.verify(token);
          if (!clerkUserId) {
            return reply
              .code(401)
              .send({ error: { code: 'unauthorized', message: 'invalid session' } });
          }
          let user = (
            await deps.db
              .select({ id: consoleUsers.id, accountId: consoleUsers.accountId })
              .from(consoleUsers)
              .where(eq(consoleUsers.clerkUserId, clerkUserId))
              .limit(1)
          )[0];
          if (!user) {
            const profile = await deps.clerk.getUser(clerkUserId);
            if (!profile) {
              return reply
                .code(401)
                .send({ error: { code: 'unauthorized', message: 'clerk profile unavailable' } });
            }
            const created = await deps.accounts.findOrCreateClerkUser({
              clerkUserId,
              email: profile.email,
              name: profile.name,
            });
            user = { id: created.user.id, accountId: created.accountId };
          }
          request.consoleUserId = user.id;
          request.accountId = user.accountId;
          request.auth = { accountId: user.accountId, scopes: [...ALL_CLI_SCOPES], via: 'session' };
          return;
        }

        return reply
          .code(401)
          .send({ error: { code: 'unauthorized', message: 'invalid or expired token' } });
      }

      // 2) Console session path ⇒ all scopes.
      const userId = readSession(request);
      if (!userId) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'login required' } });
      }
      const [user] = await deps.db
        .select({ id: consoleUsers.id, accountId: consoleUsers.accountId })
        .from(consoleUsers)
        .where(eq(consoleUsers.id, userId))
        .limit(1);
      if (!user) {
        return reply.code(401).send({ error: { code: 'unauthorized', message: 'stale session' } });
      }
      request.consoleUserId = user.id;
      request.accountId = user.accountId;
      request.auth = { accountId: user.accountId, scopes: [...ALL_CLI_SCOPES], via: 'session' };
    });
  });
}

/**
 * Per-route scope guard (B3-D5). Use as a `preHandler`. Assumes `resolveAuth` ran
 * on the same encapsulated scope, so `request.auth` is set (a missing one → 401 as
 * a defensive fallback). A token lacking the scope → 403 `insufficient_scope`.
 */
export function requireScope(scope: CliScope): preHandlerHookHandler {
  return (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => {
    const auth = request.auth;
    if (!auth) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'login required' } });
      return;
    }
    if (!auth.scopes.includes(scope)) {
      reply.code(403).send({
        error: { code: 'insufficient_scope', message: `token is missing the '${scope}' scope` },
      });
      return;
    }
    done();
  };
}
