import { readyResponseSchema } from '@signal/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { parseEnv } from '../src/env.js';
import { startTestDb } from './testDb.js';

/**
 * Deep readiness (B4-D3): `/ready` deep-checks the DB (required) and S3
 * (best-effort). The `/health` liveness probe stays a pure 200. The DB-down case
 * wraps the real Db so `execute('select 1')` throws while `select()` (used by the
 * startup cache refresh) still works — proving the 503 gate without tearing the
 * shared container down mid-suite.
 */
const env = parseEnv({ NODE_ENV: 'test' });

describe('/health and /ready (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  it('/health is always 200 (liveness)', async () => {
    const app = await buildApp(env, { db: t.db, closeDb: async () => {} });
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ok');
    } finally {
      await app.close();
    }
  });

  it('/ready → 200 ready with db ok when the DB is reachable', async () => {
    const app = await buildApp(env, { db: t.db, closeDb: async () => {} });
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      const body = res.json();
      expect(readyResponseSchema.safeParse(body).success).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(body.status).toBe('ready');
      expect(body.checks.db).toBe('ok');
      // S3 is best-effort; against the local MinIO it is 'ok', but if the bucket
      // isn't reachable in CI the check must still not fail readiness.
      expect(['ok', 'down']).toContain(body.checks.s3);
    } finally {
      await app.close();
    }
  });

  it('/ready → 503 not_ready when the DB select fails', async () => {
    // Wrap the real Db: `execute` throws (the readiness probe), everything else
    // (including `select` used by the startup cache refresh) delegates through.
    const brokenDb = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'execute') {
          return async () => {
            throw new Error('simulated DB outage');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;

    const app = await buildApp(env, { db: brokenDb, closeDb: async () => {} });
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.status).toBe('not_ready');
      expect(body.checks.db).toBe('down');

      // Liveness stays green even when readiness is red.
      const live = await app.inject({ method: 'GET', url: '/health' });
      expect(live.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
