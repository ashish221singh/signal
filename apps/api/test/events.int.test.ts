import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { systemClock } from '../src/clock.js';
import type { Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { EligibilityService } from '../src/eligibility/service.js';
import { parseEnv } from '../src/env.js';
import { upsertSeenEvent } from '../src/events/repo.js';
import { SeenEventSet } from '../src/events/seenSet.js';
import { TokenService } from '../src/tokens/service.js';
import { WorkflowCache } from '../src/workflows/cache.js';
import { seedAccountWithUser, startTestDb } from './testDb.js';

const env = parseEnv({ NODE_ENV: 'test' });

describe('event surfacing (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let accountId: string;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });
  beforeEach(async () => {
    await t.truncateAll();
    accountId = (await seedAccountWithUser(t.db as Db)).accountId;
  });

  it('fires the upsert once on first sighting, never again in steady state (no per-call DB write)', async () => {
    const cache = new WorkflowCache(async () => []);
    await cache.refresh();
    const upsertSpy = vi.fn(async () => {});
    const svc = new EligibilityService(
      t.db,
      cache,
      systemClock,
      Math.random,
      new SeenEventSet(),
      upsertSpy,
    );

    for (let i = 0; i < 25; i++) {
      await svc.check({ accountId, eventName: 'checkout_completed', userId: `u${i}` });
    }
    // Exactly ONE upsert despite 25 calls — steady state hits only memory.
    expect(upsertSpy).toHaveBeenCalledTimes(1);

    // A different event fires exactly one more.
    await svc.check({ accountId, eventName: 'signup_done', userId: 'u' });
    expect(upsertSpy).toHaveBeenCalledTimes(2);
  });

  it('persists the real upsert (idempotent, bumps hit_count) when unspied', async () => {
    // Call the real upsert directly twice to prove idempotency.
    const now = new Date();
    await upsertSeenEvent(t.db, accountId, 'e', now);
    await upsertSeenEvent(t.db, accountId, 'e', new Date(now.getTime() + 1000));
    // one row, hit_count bumped to 2
    const rows = await t.db.select().from(schema.seenEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hitCount).toBe(2);
  });

  it('surfaces via GET /v1/console/events after an eligibility call', async () => {
    const app = await buildApp(env, { db: t.db, closeDb: async () => {} });
    try {
      const token = (await new TokenService(t.db).issue(accountId, 'ci')).token;

      // Hit the SDK eligibility endpoint for a novel event (no workflow needed).
      const key = 'pk_test_eventsurface0000001';
      await t.db
        .insert(schema.apiKeys)
        .values({ accountId, key, label: 'test', environment: 'test' });

      await app.inject({
        method: 'GET',
        url: '/v1/sdk/eligibility',
        headers: { 'x-signal-app-key': key },
        query: { event_name: 'page_viewed', user_id: 'u1' },
      });
      // allow the fire-and-forget upsert to settle
      await new Promise((r) => setTimeout(r, 50));

      const res = await app.inject({
        method: 'GET',
        url: '/v1/console/events',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const names = res.json().events.map((e: { event_name: string }) => e.event_name);
      expect(names).toContain('page_viewed');
    } finally {
      await app.close();
    }
  });

  it('isolates events across accounts', async () => {
    const app = await buildApp(env, { db: t.db, closeDb: async () => {} });
    try {
      const tokenA = (await new TokenService(t.db).issue(accountId, 'a')).token;
      // Seed a seen_event for A directly.
      await upsertSeenEvent(t.db, accountId, 'a_only', new Date());
      const other = (await seedAccountWithUser(t.db as Db, { email: 'b@example.com' })).accountId;
      const tokenB = (await new TokenService(t.db).issue(other, 'b')).token;

      const aRes = await app.inject({
        method: 'GET',
        url: '/v1/console/events',
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(aRes.json().events.map((e: { event_name: string }) => e.event_name)).toContain(
        'a_only',
      );
      const bRes = await app.inject({
        method: 'GET',
        url: '/v1/console/events',
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(bRes.json().events).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
