import { SIGNAL_API_VERSION } from '@signal/contracts';
import Fastify, { type FastifyError } from 'fastify';
import { CampaignCache } from './campaigns/cache.js';
import { makeDbCampaignLoader } from './campaigns/loader.js';
import { type Clock, systemClock } from './clock.js';
import { createDb, type Db } from './db/client.js';
import { EligibilityService } from './eligibility/service.js';
import type { Env } from './env.js';
import { appKeyAuth } from './plugins/appKeyAuth.js';
import { sdkRoutes } from './routes/sdk.js';

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

  const cache = new CampaignCache(makeDbCampaignLoader(resolvedDb));
  await cache.refresh();
  cache.startAutoRefresh(60_000, (e) => app.log.error(e, 'campaign cache refresh failed'));

  const eligibility = new EligibilityService(resolvedDb, cache, clock);

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
    return reply.code(500).send({ error: { code: 'internal', message: 'internal error' } });
  });

  app.get('/health', async () => ({ status: 'ok' as const, version: SIGNAL_API_VERSION }));

  await app.register(
    async (sdk) => {
      await sdk.register(appKeyAuth(env.appKeys));
      await sdk.register(
        sdkRoutes({
          db: resolvedDb,
          clock,
          eligibility,
        }),
      );
    },
    { prefix: '/v1/sdk' },
  );

  app.addHook('onClose', async () => {
    cache.stop();
    if (closeDb) await closeDb();
  });

  return app;
}
