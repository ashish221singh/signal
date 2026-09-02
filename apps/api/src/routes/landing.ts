import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Serve the marketing landing page at `/` (F3 deploy). The page + the `@signal/tokens`
 * CSS and fonts are served same-origin so the whole journey (landing → /app/login →
 * dashboard) lives on one host. The landing's stylesheet link (`../../packages/tokens/
 * tokens.css`, correct for opening the file directly) is rewritten to `/_assets/
 * tokens.css`; tokens.css's own `./fonts/*` URLs then resolve to `/_assets/fonts/*`.
 * Files are read once and cached in memory.
 */
// This file lives at apps/api/src/routes/ — four levels up is the repo root.
const landingHtmlPath = fileURLToPath(
  new URL('../../../../design/final-version/landing.html', import.meta.url),
);
const tokensCssPath = fileURLToPath(
  new URL('../../../../packages/tokens/tokens.css', import.meta.url),
);
const fontsDir = fileURLToPath(new URL('../../../../packages/tokens/fonts', import.meta.url));

export function landingRoutes(): FastifyPluginAsync {
  return async (app) => {
    let html: string | null = null;
    let css: string | null = null;

    app.get('/', async (_req, reply) => {
      if (html === null) {
        html = (await readFile(landingHtmlPath, 'utf8')).replace(
          '../../packages/tokens/tokens.css',
          '/_assets/tokens.css',
        );
      }
      return reply.type('text/html; charset=utf-8').send(html);
    });

    app.get('/_assets/tokens.css', async (_req, reply) => {
      // `./fonts/*` URLs inside resolve to `/_assets/fonts/*` (served below).
      if (css === null) css = await readFile(tokensCssPath, 'utf8');
      return reply.type('text/css; charset=utf-8').send(css);
    });

    await app.register(fastifyStatic, {
      root: fontsDir,
      prefix: '/_assets/fonts/',
      decorateReply: false,
    });
  };
}
