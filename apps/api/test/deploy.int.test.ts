import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import * as s from '../src/db/schema.js';
import { parseEnv } from '../src/env.js';
import { TokenService } from '../src/tokens/service.js';
import { seedAccountWithUser, startTestDb } from './testDb.js';

const env = parseEnv({ NODE_ENV: 'test' });

const CSAT = {
  event_name: 'checkout_completed',
  metric_type: 'CSAT' as const,
  rating_type: 'star' as const,
  rating_scale_max: 5,
  header_text: 'How was checkout?',
  positive_threshold: 4,
};

describe('POST /v1/console/deploy (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let accountId: string;
  let token: string;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });
  beforeEach(async () => {
    await t.truncateAll();
    const seeded = await seedAccountWithUser(t.db as Db);
    accountId = seeded.accountId;
    token = (await new TokenService(t.db).issue(accountId, 'deployer')).token;
    app = await buildApp(env, { db: t.db, closeDb: async () => {} });
  });
  afterEach(async () => {
    await app.close();
  });

  const deploy = (workflows: unknown[]) =>
    app.inject({
      method: 'POST',
      url: '/v1/console/deploy',
      headers: { authorization: `Bearer ${token}` },
      payload: { workflows },
    });

  it('creates a code-managed active workflow, then is idempotent', async () => {
    const first = await deploy([{ key: 'checkout', ...CSAT }]);
    expect(first.statusCode).toBe(200);
    const r1 = first.json().results;
    expect(r1).toHaveLength(1);
    expect(r1[0]).toMatchObject({ key: 'checkout', action: 'created', status: 'active' });

    const [row] = await t.db.select().from(s.workflows);
    expect(row?.managedBy).toBe('code');
    expect(row?.key).toBe('checkout');
    expect(row?.status).toBe('active');

    // same payload again → unchanged
    const second = await deploy([{ key: 'checkout', ...CSAT }]);
    expect(second.json().results[0]).toMatchObject({ action: 'unchanged', status: 'active' });
    // still exactly one row
    expect((await t.db.select().from(s.workflows)).length).toBe(1);
  });

  it('updates content on a changed payload', async () => {
    await deploy([{ key: 'checkout', ...CSAT }]);
    const changed = await deploy([{ key: 'checkout', ...CSAT, header_text: 'Rate your checkout' }]);
    expect(changed.json().results[0].action).toBe('updated');
    const [row] = await t.db.select().from(s.workflows);
    expect(row?.headerText).toBe('Rate your checkout');
  });

  it('prunes (archives) a code-managed workflow absent from the payload', async () => {
    await deploy([
      { key: 'a', ...CSAT, event_name: 'event_a' },
      { key: 'b', ...CSAT, event_name: 'event_b' },
    ]);
    // redeploy with only `a`
    const res = await deploy([{ key: 'a', ...CSAT, event_name: 'event_a' }]);
    const results = res.json().results;
    const pruned = results.find((x: { key: string }) => x.key === 'b');
    expect(pruned).toMatchObject({ action: 'pruned', status: 'archived' });
    const bRow = (await t.db.select().from(s.workflows)).find((w) => w.key === 'b');
    expect(bRow?.status).toBe('archived');
  });

  it('reports event_conflict per item but still applies the rest (partial success)', async () => {
    // A console-managed active workflow already owns `checkout_completed`.
    await t.db.insert(s.workflows).values({
      accountId,
      eventName: 'checkout_completed',
      metricType: 'CSAT',
      ratingType: 'star',
      ratingScaleMax: 5,
      headerText: 'Console owns this',
      positiveThreshold: 4,
      status: 'active',
      managedBy: 'console',
      createdBy: 'console',
    });

    const res = await deploy([
      { key: 'conflicting', ...CSAT, event_name: 'checkout_completed' },
      { key: 'fine', ...CSAT, event_name: 'other_event' },
    ]);
    expect(res.statusCode).toBe(200);
    const results = res.json().results;
    const conflict = results.find((x: { key: string }) => x.key === 'conflicting');
    expect(conflict.action).toBe('failed');
    expect(conflict.error.code).toBe('event_conflict');
    expect(conflict.error.conflict.header).toBe('Console owns this');
    // the other item still applied
    const fine = results.find((x: { key: string }) => x.key === 'fine');
    expect(fine).toMatchObject({ action: 'created', status: 'active' });
  });

  it('a draft-status deploy item does not publish', async () => {
    const res = await deploy([{ key: 'wip', ...CSAT, status: 'draft' }]);
    expect(res.json().results[0]).toMatchObject({ action: 'created', status: 'draft' });
  });

  it('an incomplete active item fails with incomplete + missing', async () => {
    const res = await deploy([{ key: 'bare', event_name: 'x', status: 'active' }]);
    const item = res.json().results[0];
    expect(item.action).toBe('failed');
    expect(item.error.code).toBe('incomplete');
    expect(item.error.missing).toContain('metric_type');
  });

  it('locks code-managed workflows against console/MCP edits (409 code_managed)', async () => {
    await deploy([{ key: 'locked', ...CSAT }]);
    const [row] = await t.db.select().from(s.workflows);
    const id = row!.id;

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/console/workflows/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { header_text: 'sneaky' },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error.code).toBe('code_managed');

    const pause = await app.inject({
      method: 'POST',
      url: `/v1/console/workflows/${id}/pause`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(pause.statusCode).toBe(409);
    expect(pause.json().error.code).toBe('code_managed');

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/console/workflows/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe('code_managed');
  });

  it('rejects a payload with duplicate keys (422)', async () => {
    const res = await deploy([
      { key: 'dup', ...CSAT, event_name: 'a' },
      { key: 'dup', ...CSAT, event_name: 'b' },
    ]);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('duplicate_key');
  });

  it('requires the deploy scope (403 for a token without it)', async () => {
    const roToken = (
      await new TokenService(t.db).issue(accountId, 'ro', { scopes: ['workflows:read'] })
    ).token;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/console/deploy',
      headers: { authorization: `Bearer ${roToken}` },
      payload: { workflows: [] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
  });

  it('isolates deploy across accounts', async () => {
    await deploy([{ key: 'mine', ...CSAT }]);
    const other = await seedAccountWithUser(t.db as Db, { email: 'other@example.com' });
    const otherToken = (await new TokenService(t.db).issue(other.accountId, 'o')).token;

    // Other account deploys with an EMPTY payload — must NOT prune my workflow.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/console/deploy',
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { workflows: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(0);
    const mine = (await t.db.select().from(s.workflows)).find((w) => w.key === 'mine');
    expect(mine?.status).toBe('active');
  });

  it('deployed active workflow is immediately eligible (cache refreshed)', async () => {
    // Need a publishable key for the SDK call.
    const key = 'pk_test_deploycache00000001';
    await t.db.insert(s.apiKeys).values({ accountId, key, label: 'test', environment: 'test' });
    await deploy([{ key: 'checkout', ...CSAT }]);

    const elig = await app.inject({
      method: 'GET',
      url: '/v1/sdk/eligibility',
      headers: { 'x-signal-app-key': key },
      query: { event_name: 'checkout_completed', user_id: 'u1' },
    });
    expect(elig.statusCode).toBe(200);
    expect(elig.json()).not.toBeNull();
    expect(elig.json().metric_type).toBe('CSAT');
  });
});
