import { SIGNAL_API_VERSION } from '@signal/contracts';
import Fastify from 'fastify';
import type { Env } from './env.js';

export async function buildApp(env: Env) {
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL },
  });

  app.get('/health', async () => ({
    status: 'ok' as const,
    version: SIGNAL_API_VERSION,
  }));

  return app;
}
