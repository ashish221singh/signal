import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/env.js';
import { startTestDb } from './testDb.js';

const env = parseEnv({ NODE_ENV: 'test' });

describe('landing page serving (F3 deploy)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    t = await startTestDb();
    app = await buildApp(env, { db: t.db, closeDb: async () => {} });
  }, 120_000);
  afterAll(async () => {
    await app.close();
    await t.stop();
  });

  it('GET / serves the landing HTML with the token link rewritten to /_assets', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('/_assets/tokens.css');
    expect(res.body).not.toContain('../../packages/tokens/tokens.css');
    expect(res.body).toContain('npx @ashish221/signal-cli init');
  });

  it('GET /_assets/tokens.css serves the token stylesheet', async () => {
    const res = await app.inject({ method: 'GET', url: '/_assets/tokens.css' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.body).toContain('--font-display');
  });
});
