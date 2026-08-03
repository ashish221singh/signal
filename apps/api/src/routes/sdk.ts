import { dismissBodySchema, eligibilityQuerySchema, responseBodySchema } from '@signal/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import type { EligibilityService } from '../eligibility/service.js';
import type { Env } from '../env.js';
import { recordDismiss } from '../feedback/dismiss.js';
import { recordResponse } from '../feedback/respond.js';

export function sdkRoutes(deps: {
  db: Db;
  clock: Clock;
  env: Env;
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
        accountId: request.accountId as string,
        eventName: parsed.data.event_name,
        userId: parsed.data.user_id,
        context: parsed.data.context,
        sessionAgeDays: parsed.data.session_age_days,
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
      const result = await recordResponse(
        deps.db,
        deps.clock,
        deps.env,
        request.accountId as string,
        parsed.data,
      );
      if (result === 'unknown_trigger')
        return reply
          .code(404)
          .send({ error: { code: 'unknown_trigger', message: 'no such trigger_id' } });
      if (result === 'invalid_rating')
        return reply
          .code(422)
          .send({ error: { code: 'invalid_rating', message: 'rating outside workflow scale' } });
      // B4-D1: a supplied image URL outside the caller's account prefix → 422.
      if (result === 'invalid_image_url')
        return reply.code(422).send({
          error: {
            code: 'invalid_image_url',
            message: 'other_image_url is not under this account prefix',
          },
        });
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
    // immediate reload of active workflows into the SDK cache, so a
    // publish/pause is reflected in `/eligibility` without waiting on the 60s
    // auto-refresh timer. It is idempotent (just reloads from the DB) and sits
    // inside this app-key-guarded SDK scope, so the same `X-Signal-App-Key`
    // header protects it. Used by the console end-to-end demo for a
    // deterministic build→publish→fire→pause loop.
    app.post('/internal/refresh-cache', async (request, reply) => {
      await request.server.workflowCache.refresh();
      return reply.code(204).send();
    });
  };
}
