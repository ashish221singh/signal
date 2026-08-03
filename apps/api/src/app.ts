import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { SIGNAL_API_VERSION } from '@signal/contracts';
import Fastify, { type FastifyError } from 'fastify';
import { AccountsService } from './accounts/service.js';
import { type Clock, systemClock } from './clock.js';
import { createDb, type Db } from './db/client.js';
import { EligibilityService } from './eligibility/service.js';
import type { Env } from './env.js';
import { publishableKeyAuth } from './plugins/publishableKeyAuth.js';
import { resolveAuth } from './plugins/resolveAuth.js';
import { consoleAuthRoutes } from './routes/console/auth.js';
import { reportingRoutes } from './routes/console/reporting.js';
import { workflowRoutes } from './routes/console/workflows.js';
import { sdkRoutes } from './routes/sdk.js';
import { uploadRoutes } from './routes/uploads.js';
import { TokenService } from './tokens/service.js';
import { makeS3 } from './uploads/presign.js';
import { WorkflowCache } from './workflows/cache.js';
import { makeDbWorkflowLoader } from './workflows/loader.js';

/**
 * Expose the SDK workflow cache on the Fastify instance so its `refresh()` is
 * reachable deterministically (the cross-milestone publish→eligibility test, and
 * the refresh endpoint) without waiting on the 60s auto-refresh timer.
 */
declare module 'fastify' {
  interface FastifyInstance {
    workflowCache: WorkflowCache;
  }
}

export interface AppDeps {
  db?: Db;
  clock?: Clock;
  closeDb?: () => Promise<void>;
}

export async function buildApp(env: Env, deps: AppDeps = {}) {
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL },
  });

  let closeDb = deps.closeDb;
  let db = deps.db;
  if (!db) {
    const created = createDb(env.DATABASE_URL);
    db = created.db;
    closeDb = created.close;
  }
  const resolvedDb = db;
  const clock = deps.clock ?? systemClock;

  const cache = new WorkflowCache(makeDbWorkflowLoader(resolvedDb));
  await cache.refresh();
  cache.startAutoRefresh(60_000, (e) => app.log.error(e, 'workflow cache refresh failed'));

  // Expose the SDK workflow cache on the app so a deterministic `refresh()` is
  // reachable without waiting on the 60s timer. Used by the cross-milestone
  // publish→eligibility integration test and the refresh endpoint. The
  // eligibility hot path is unchanged — it still reads the same cache.
  app.decorate('workflowCache', cache);

  const eligibility = new EligibilityService(resolvedDb, cache, clock);
  const accountsService = new AccountsService(resolvedDb);
  const tokenService = new TokenService(resolvedDb, clock);

  // One S3 client for the app lifetime — shared by the SDK upload route. Its
  // close is a no-op, so there is nothing to tear down in `onClose`.
  const s3 = makeS3(env);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(error);
    // Fastify raises client-side parse/validation failures (e.g. malformed JSON
    // body, unsupported content type, empty JSON body) with statusCode 400.
    // Per M1-D18 we surface those as 422 with the standard error envelope while
    // keeping a generic 500 for anything truly unexpected (fail-silent guarantee).
    // Registered BEFORE the /v1/sdk scope so the encapsulated child inherits it.
    if (error.statusCode === 400) {
      return reply
        .code(422)
        .send({ error: { code: 'invalid_body', message: 'malformed request body' } });
    }
    // @fastify/rate-limit signals an exceeded limit by raising an error with
    // statusCode 429 (M2-D4). Without this branch the generic handler below would
    // collapse it into a 500; surface it in the standard envelope (M2-D16).
    if (error.statusCode === 429) {
      return reply
        .code(429)
        .send({ error: { code: 'rate_limited', message: 'too many requests' } });
    }
    return reply.code(500).send({ error: { code: 'internal', message: 'internal error' } });
  });

  // Cookie plugin must be registered before any route reads/writes signed
  // cookies. The secret enables `signed: true` cookies + `request.unsignCookie`
  // (M2-D2). @fastify/cookie v11 registration API matches the plan snippet.
  await app.register(cookie, { secret: env.SESSION_SECRET });
  // Rate limit registered globally-disabled (`global: false`) so it only applies
  // to routes that opt in via `config.rateLimit` — the console login route
  // (5/min/IP, M2-D4). @fastify/rate-limit v11 honors per-route config in child
  // scopes when the plugin is registered on an ancestor scope.
  await app.register(rateLimit, { global: false });

  app.get('/health', async () => ({ status: 'ok' as const, version: SIGNAL_API_VERSION }));

  // Console auth (login/logout/me) — NOT behind the session guard; login must be
  // reachable without a session. The guarded console subtree arrives in Task 7.
  await app.register(consoleAuthRoutes({ db: resolvedDb }), { prefix: '/v1/console/auth' });

  // Guarded console subtree (M2 Task 7, B3-D5): the fp-wrapped `resolveAuth` runs
  // on every request into this encapsulated scope, accepting EITHER a cookie
  // session (⇒ all scopes) OR an `Authorization: Bearer cli_…` token (⇒ the
  // token's scopes). Sibling routes are protected. Separate register from
  // `/v1/console/auth` above — login/logout/me stay reachable without a cookie.
  await app.register(
    async (consoleApi) => {
      await consoleApi.register(resolveAuth({ db: resolvedDb, tokens: tokenService }));
      await consoleApi.register(workflowRoutes({ db: resolvedDb, clock }), {
        prefix: '/workflows',
      });
      // Reporting: mounted with NO sub-prefix — its routes carry their own
      // `/workflows/:id/overview` and `/dashboard` paths, distinct from
      // workflowRoutes above. The clock feeds the dashboard's 30-day window.
      await consoleApi.register(reportingRoutes({ db: resolvedDb, clock }));
    },
    { prefix: '/v1/console' },
  );

  await app.register(
    async (sdk) => {
      // Hardening-lite (B2-D7): rate-limit the SDK ingest surface keyed by
      // publishableKey + user_id (60/min). Publishable keys are public, so this
      // blunts spoofing/abuse without per-tenant infra. Keyed off the header +
      // the request's user_id (query for GET, body for POST); falls back to the
      // key alone when no user_id is present. Over-limit → 429 (envelope in the
      // error handler above).
      await sdk.register(rateLimit, {
        max: env.SDK_RATE_LIMIT_MAX,
        timeWindow: '1 minute',
        keyGenerator: (request) => {
          const key =
            typeof request.headers['x-signal-app-key'] === 'string'
              ? request.headers['x-signal-app-key']
              : 'anon';
          const q = request.query as { user_id?: unknown } | undefined;
          const b = request.body as { trigger_id?: unknown } | undefined;
          const user =
            (q && typeof q.user_id === 'string' && q.user_id) ||
            (b && typeof b.trigger_id === 'string' && b.trigger_id) ||
            'anon';
          return `${key}:${user}`;
        },
      });
      await sdk.register(publishableKeyAuth((key) => accountsService.resolveKey(key)));
      await sdk.register(
        sdkRoutes({
          db: resolvedDb,
          clock,
          eligibility,
        }),
      );
      await sdk.register(uploadRoutes({ s3, env }));
    },
    { prefix: '/v1/sdk' },
  );

  app.addHook('onClose', async () => {
    cache.stop();
    if (closeDb) await closeDb();
  });

  return app;
}
