import { HeadBucketCommand } from '@aws-sdk/client-s3';
import cookie from '@fastify/cookie';
import cors, { type FastifyCorsOptionsDelegatePromise } from '@fastify/cors';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import { SIGNAL_API_VERSION } from '@signal/contracts';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyError } from 'fastify';
import { AccountsService } from './accounts/service.js';
import { DeviceService } from './cli/deviceService.js';
import { type Clock, systemClock } from './clock.js';
import { createDb, type Db } from './db/client.js';
import { EligibilityService } from './eligibility/service.js';
import type { Env } from './env.js';
import { publishableKeyAuth } from './plugins/publishableKeyAuth.js';
import { resolveAuth } from './plugins/resolveAuth.js';
import { cliRoutes } from './routes/cli.js';
import { consoleAuthRoutes } from './routes/console/auth.js';
import { deployRoutes } from './routes/console/deploy.js';
import { eventRoutes } from './routes/console/events.js';
import { managementRoutes } from './routes/console/management.js';
import { reportingRoutes } from './routes/console/reporting.js';
import { userDataRoutes } from './routes/console/users.js';
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
  const deviceService = new DeviceService(resolvedDb, tokenService, clock);

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
  // Parse `application/x-www-form-urlencoded` bodies — the server-rendered CLI
  // approval page (B3-D3b) posts a native HTML form.
  await app.register(formbody);

  // Liveness (B4-D3): always 200 while the process is up. Container platforms use
  // this to decide whether to restart the instance; it does NOT touch the DB/S3.
  app.get('/health', async () => ({ status: 'ok' as const, version: SIGNAL_API_VERSION }));

  // Deep readiness (B4-D3): the DB is required (a failed `select 1` → 503); S3 is
  // best-effort (a head-bucket failure is reported but does not fail readiness,
  // since the ingest hot path never touches S3). Distinct from liveness so the
  // platform can hold traffic off an instance that can't reach Postgres.
  app.get('/ready', async (_request, reply) => {
    let dbOk = true;
    try {
      await resolvedDb.execute(sql`select 1`);
    } catch (err) {
      app.log.error(err, 'readiness: db check failed');
      dbOk = false;
    }

    let s3Status: 'ok' | 'down' = 'ok';
    try {
      await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
    } catch (err) {
      app.log.warn(err, 'readiness: s3 head-bucket failed (best-effort)');
      s3Status = 'down';
    }

    const status = dbOk ? ('ready' as const) : ('not_ready' as const);
    return reply.code(dbOk ? 200 : 503).send({
      status,
      checks: { db: dbOk ? ('ok' as const) : ('down' as const), s3: s3Status },
    });
  });

  // CLI / device-flow + server-rendered auth pages (B3-D3, D4, D3b). Mounted at
  // the root (absolute paths) and PUBLIC — the approval page self-checks the
  // console session and redirects to /login when absent.
  await app.register(
    cliRoutes({
      db: resolvedDb,
      env,
      devices: deviceService,
      tokens: tokenService,
    }),
  );

  // CORS (B4-D2). Two console registrations exist (`/v1/console/auth` and the
  // guarded `/v1/console` subtree); both get the SAME credentialed policy so the
  // dashboard can log in AND read reports cross-origin. Allowed origins come from
  // `CONSOLE_ORIGINS`. Registering cors on a scope also answers its preflight.
  const consoleCors: Parameters<typeof cors>[1] = {
    origin: env.CONSOLE_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  };

  // Console auth (login/logout/me) — NOT behind the session guard; login must be
  // reachable without a session. The guarded console subtree arrives in Task 7.
  await app.register(
    async (consoleAuth) => {
      await consoleAuth.register(cors, consoleCors);
      await consoleAuth.register(consoleAuthRoutes({ db: resolvedDb }));
    },
    { prefix: '/v1/console/auth' },
  );

  // Guarded console subtree (M2 Task 7, B3-D5): the fp-wrapped `resolveAuth` runs
  // on every request into this encapsulated scope, accepting EITHER a cookie
  // session (⇒ all scopes) OR an `Authorization: Bearer cli_…` token (⇒ the
  // token's scopes). Sibling routes are protected. Separate register from
  // `/v1/console/auth` above — login/logout/me stay reachable without a cookie.
  await app.register(
    async (consoleApi) => {
      await consoleApi.register(cors, consoleCors);
      await consoleApi.register(resolveAuth({ db: resolvedDb, tokens: tokenService }));
      await consoleApi.register(workflowRoutes({ db: resolvedDb, clock }), {
        prefix: '/workflows',
      });
      // Key & CLI-token management (B3, Task 6) — no sub-prefix; carries its own
      // `/keys` and `/cli-tokens` paths, distinct from `/workflows`.
      await consoleApi.register(managementRoutes({ db: resolvedDb, tokens: tokenService }));
      // config-as-code deploy (B3, Task 7) — `/deploy`, `deploy` scope. Refreshes
      // the SDK cache after apply so published workflows are immediately eligible.
      await consoleApi.register(
        deployRoutes({ db: resolvedDb, clock, refreshCache: () => cache.refresh() }),
      );
      // Event surfacing read route (B3, Task 8) — `/events`.
      await consoleApi.register(eventRoutes({ db: resolvedDb }));
      // User-data deletion (B4, Task 5) — `/users/:userId/data`, `workflows:write`.
      await consoleApi.register(userDataRoutes({ db: resolvedDb }));
      // Reporting: mounted with NO sub-prefix — its routes carry their own
      // `/workflows/:id/overview` and `/dashboard` paths, distinct from
      // workflowRoutes above. The clock feeds the dashboard's 30-day window.
      await consoleApi.register(reportingRoutes({ db: resolvedDb, clock }));
    },
    { prefix: '/v1/console' },
  );

  await app.register(
    async (sdk) => {
      // CORS (B4-D2): the SDK ingest surface reflects an allowed `Origin` per the
      // calling account's `allowed_origins` (B2). The delegator reads the request
      // so it can resolve the account from the `X-Signal-App-Key` header; when the
      // origin is not allow-listed (or the key/origin is absent) NO CORS headers
      // are emitted. Native SDKs send no Origin and are unaffected. An empty
      // allow-list means "any origin" (mirroring publishableKeyAuth's rule).
      const sdkCorsDelegate: FastifyCorsOptionsDelegatePromise = async (req) => {
        const key = req.headers['x-signal-app-key'];
        const origin = req.headers.origin;
        if (typeof origin !== 'string' || typeof key !== 'string') {
          return { origin: false };
        }
        const resolved = await accountsService.resolveKey(key);
        if (!resolved) return { origin: false };
        const allowed =
          resolved.allowedOrigins.length === 0 || resolved.allowedOrigins.includes(origin);
        return { origin: allowed ? origin : false, credentials: false };
      };
      await sdk.register(cors, () => sdkCorsDelegate);

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
          env,
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
