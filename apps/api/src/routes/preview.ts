import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Action, WorkflowConfig } from '@signal/web-core';
import type { FastifyPluginAsync } from 'fastify';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import type { Env } from '../env.js';
import { previewHarnessPage, previewNotFoundPage } from '../preview/harness.js';
import { verifyPreviewToken } from '../preview/token.js';
import { WorkflowService } from '../workflows/service.js';

/**
 * Public hosted-link preview surface (F2-D7, F2-D16), mounted at the app root:
 *  - `GET /s/preview/web-core.js` serves the bundled web-core IIFE (F2-D14) — the
 *    same artifact every shell hosts, never cold-fetched at show time.
 *  - `GET /s/preview/:token` verifies the signed token, loads the workflow, builds
 *    its `WorkflowConfig`, and serves the standalone harness with a non-persisting
 *    preview SheetHost. Expired/invalid/wrong-account token → a friendly 404.
 *
 * PUBLIC (no auth) — the token is the grant. It carries `account_id`, and the
 * workflow lookup is scoped to it, so a token can only ever render its own
 * account's workflow.
 */

// Resolve the bundled web-core IIFE once at module load. `@signal/web-core/bundle`
// maps to dist/web-core.global.js (F2-D14). Read synchronously — it's a small,
// immutable build artifact served with a long cache.
const require = createRequire(import.meta.url);
let cachedBundle: string | null = null;
function webCoreBundle(): string {
  if (cachedBundle === null) {
    const path = require.resolve('@signal/web-core/bundle');
    cachedBundle = readFileSync(path, 'utf8');
  }
  return cachedBundle;
}

/**
 * Build a `WorkflowConfig` for the sheet from a workflow the account owns. Preview
 * never submits, so `trigger_id`/`campaign_id` are synthetic sentinels (the sheet
 * only needs a non-empty `trigger_id` to mount; F1 normalizeConfig). An incomplete
 * draft (missing header/rating) yields null → the route 404s rather than render a
 * broken sheet.
 */
export function buildPreviewConfig(workflow: {
  id: string;
  metric_type: 'CSAT' | 'CES' | null;
  header_text: string | null;
  rating_type: 'star' | 'emoji' | 'effort_scale' | null;
  rating_scale_max: number | null;
  positive_threshold: number | null;
  chips_on_negative: string[];
  other_requires_text: boolean;
  other_allows_image: boolean;
  positive_action: Action;
  negative_action: Action;
}): WorkflowConfig | null {
  if (
    workflow.header_text === null ||
    workflow.metric_type === null ||
    workflow.rating_type === null ||
    workflow.rating_scale_max === null ||
    workflow.positive_threshold === null
  ) {
    return null;
  }
  return {
    trigger_id: 'preview',
    campaign_id: workflow.id,
    metric_type: workflow.metric_type,
    header: workflow.header_text,
    rating_type: workflow.rating_type,
    rating_scale_max: workflow.rating_scale_max,
    positive_threshold: workflow.positive_threshold,
    chips_on_negative: workflow.chips_on_negative,
    other_requires_text: workflow.other_requires_text,
    other_allows_image: workflow.other_allows_image,
    positive_action: workflow.positive_action,
    negative_action: workflow.negative_action,
    skip_enabled: true,
  };
}

export function previewServeRoutes(deps: { db: Db; clock: Clock; env: Env }): FastifyPluginAsync {
  const service = new WorkflowService(deps.db, deps.clock);
  return async (app) => {
    // The bundled web-core IIFE (F2-D14). Long cache: it is immutable per build.
    app.get('/s/preview/web-core.js', async (_request, reply) => {
      return reply
        .type('application/javascript; charset=utf-8')
        .header('cache-control', 'public, max-age=3600')
        .send(webCoreBundle());
    });

    // Signed tokens are long (base64url payload + HMAC); the server-level
    // `maxParamLength` (app.ts) is raised so a valid token routes here rather than
    // being 414'd before it can reach the friendly-404 path.
    app.get<{ Params: { token: string } }>('/s/preview/:token', async (request, reply) => {
      const claims = verifyPreviewToken(
        request.params.token,
        deps.env.SESSION_SECRET,
        deps.clock.now().getTime(),
      );
      if (!claims) {
        return reply.type('text/html').code(404).send(previewNotFoundPage());
      }
      // Scope the lookup to the token's account — a stale token whose workflow was
      // deleted, or any cross-account trickery, resolves to nothing → friendly 404.
      const workflow = await service.getById(claims.account_id, claims.workflow_id);
      const config = workflow ? buildPreviewConfig(workflow) : null;
      if (!config) {
        return reply.type('text/html').code(404).send(previewNotFoundPage());
      }
      return reply
        .type('text/html')
        .send(previewHarnessPage({ config, bundleUrl: '/s/preview/web-core.js' }));
    });
  };
}
