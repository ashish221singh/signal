import { healthResponseSchema } from '@signal/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { parseEnv } from './env.js';

describe('GET /health', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp(parseEnv({ NODE_ENV: 'test' }));
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with a body matching the health contract', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const parsed = healthResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
  });

  it('returns 404 for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
  });
});
