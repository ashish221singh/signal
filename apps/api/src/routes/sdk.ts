import { dismissBodySchema, eligibilityQuerySchema, responseBodySchema } from '@signal/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import type { EligibilityService } from '../eligibility/service.js';
import { recordDismiss } from '../feedback/dismiss.js';
import { recordResponse } from '../feedback/respond.js';

export function sdkRoutes(deps: {
  db: Db;
  clock: Clock;
  eligibility: EligibilityService;
}): FastifyPluginAsync {
  return async (app) => {
    app.get('/eligibility', async (request, reply) => {
      const parsed = eligibilityQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'invalid_query', message: parsed.error.issues[0]?.message ?? 'invalid' },
        });
      }
      const config = await deps.eligibility.check({
        screenId: parsed.data.screen_id,
        userId: parsed.data.user_id,
        clientId: parsed.data.client_id,
        repTenureDays: parsed.data.rep_tenure_days,
      });
      if (!config) return reply.code(204).send();
      return reply.code(200).send(config);
    });

    app.post('/response', async (request, reply) => {
      const parsed = responseBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'invalid_body', message: parsed.error.issues[0]?.message ?? 'invalid' },
        });
      }
      const result = await recordResponse(deps.db, deps.clock, parsed.data);
      if (result === 'unknown_trigger')
        return reply
          .code(404)
          .send({ error: { code: 'unknown_trigger', message: 'no such trigger_id' } });
      if (result === 'invalid_rating')
        return reply
          .code(422)
          .send({ error: { code: 'invalid_rating', message: 'rating outside campaign scale' } });
      return reply.code(204).send();
    });

    app.post('/dismiss', async (request, reply) => {
      const parsed = dismissBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'invalid_body', message: parsed.error.issues[0]?.message ?? 'invalid' },
        });
      }
      const result = await recordDismiss(deps.db, deps.clock, parsed.data);
      if (result === 'unknown_trigger')
        return reply
          .code(404)
          .send({ error: { code: 'unknown_trigger', message: 'no such trigger_id' } });
      return reply.code(204).send();
    });

    // POST /internal/refresh-cache — operational/test hook that forces an
    // immediate reload of active campaigns into the SDK cache, so a
    // publish/pause is reflected in `/eligibility` without waiting on the 60s
    // auto-refresh timer. It is idempotent (just reloads from the DB) and sits
    // inside this app-key-guarded SDK scope, so the same `X-Signal-App-Key`
    // header protects it. Used by the console end-to-end demo for a
    // deterministic build→publish→fire→pause loop.
    app.post('/internal/refresh-cache', async (request, reply) => {
      await request.server.campaignCache.refresh();
      return reply.code(204).send();
    });
  };
}
