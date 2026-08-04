import type { S3Client } from '@aws-sdk/client-s3';
import { uploadRequestSchema } from '@signal/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { Env } from '../env.js';
import { presignUpload } from '../uploads/presign.js';

/**
 * Pre-signed image upload (M3-0.2). The SDK POSTs a `content_type`, gets back a
 * short-lived S3 PUT URL plus the eventual public object URL. This plugin is
 * mounted inside the existing `/v1/sdk` app-key scope, so the same
 * `X-Signal-App-Key` header protects it (401 for missing/invalid keys).
 */
export function uploadRoutes(deps: { s3: S3Client; env: Env }): FastifyPluginAsync {
  return async (app) => {
    app.post('/uploads', async (request, reply) => {
      const parsed = uploadRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'invalid_body', message: parsed.error.issues[0]?.message ?? 'invalid' },
        });
      }
      // B4-D1: presign only within the caller's `acct/<accountId>/` prefix. The
      // publishableKeyAuth hook set `request.accountId` for this SDK scope.
      const ticket = await presignUpload(
        deps.s3,
        deps.env,
        request.accountId as string,
        parsed.data.content_type,
      );
      return reply.code(200).send(ticket);
    });
  };
}
