// End-to-end proof (F2 "prove it end-to-end"): the REAL loop, driven by the REAL
// Web SDK against the REAL API on Testcontainers Postgres.
//
//   signup → publishable key → publish a workflow → Signal.init + Signal.track
//     → (SDK) POST /v1/sdk/eligibility → server claims a trigger → host.submit
//     → (SDK outbox) POST /v1/sdk/response → assert stored + visible via reporting.
//
// The SDK's own networking (eligibility client + IndexedDB outbox + response POST +
// the Answer→ResponseBody mapping in its SheetHost) runs UNMODIFIED; only its
// `fetch` is routed into `app.inject` (no socket needed, same as the CLI e2e).
//
// This is the SDK-networking + API-integration level of the loop, run in the node
// test environment (Testcontainers' migrator needs a real `file:` import.meta.url,
// which the happy-dom env clobbers). Because there is no DOM, `Signal.track` runs
// the real eligibility call and the server claims a trigger, but skips the visual
// `mount` — the web-core SHEET render + tap is covered by the @signal/web-core and
// @signal/web DOM suites. We therefore assert the SERVER-SIDE trigger claim (proof
// eligibility round-tripped a real config) and drive the same `createWebHost` submit
// web-core would invoke. A full headless-browser e2e is out of scope for this pass —
// stated explicitly rather than faked.
import 'fake-indexeddb/auto';
import { __resetForTests, Signal } from '@ashish221/signal-web';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/env.js';
import { startTestDb } from './testDb.js';

const env = parseEnv({ NODE_ENV: 'test' });

// Minimal in-memory localStorage so the SDK's anon-id (F2-D9) and local-suppression
// cache (F2-D11) behave as they do in a browser — this test runs in the node env
// (Testcontainers needs a real `file:` import.meta.url the happy-dom env clobbers),
// which has no Web Storage. The SDK reads/writes it exactly as on the web.
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

/** Route the SDK's fetch into the ephemeral Fastify app (no port). Handles the
 *  GET eligibility (query string + X-Signal-App-Key) and POST response/dismiss/
 *  uploads (JSON body + header) the SDK actually issues. */
function injectFetch(app: Awaited<ReturnType<typeof buildApp>>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET') as 'GET';
    const headers = (init?.headers as Record<string, string>) ?? {};
    let payload: Record<string, unknown> | undefined;
    if (typeof init?.body === 'string') {
      try {
        payload = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        payload = undefined;
      }
    }
    const res = await app.inject({
      method,
      url: url.pathname + url.search,
      headers,
      payload,
    });
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      json: async () => (res.body ? JSON.parse(res.body) : {}),
      text: async () => res.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function signup(app: Awaited<ReturnType<typeof buildApp>>) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/console/auth/signup',
    payload: {
      account_name: 'E2E Co',
      name: 'E2E Owner',
      email: `e2e+${Date.now()}@example.com`,
      password: 'supersecret123',
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  const cookie = (
    Array.isArray(res.headers['set-cookie'])
      ? res.headers['set-cookie']
      : [res.headers['set-cookie']]
  )
    .find((c) => c?.startsWith('signal_session='))
    ?.split(';')[0] as string;
  return { publishableKey: body.publishable_key as string, cookie };
}

async function publishWorkflow(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  eventName: string,
): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/console/workflows',
    headers: { cookie },
    payload: {},
  });
  const id = created.json().id as string;
  await app.inject({
    method: 'PATCH',
    url: `/v1/console/workflows/${id}`,
    headers: { cookie },
    payload: {
      event_name: eventName,
      metric_type: 'CSAT',
      rating_type: 'emoji',
      rating_scale_max: 3,
      header_text: 'How was checkout?',
      positive_threshold: 3,
      ask_frequency: 'after_7_days',
      // Fire every time so the e2e is deterministic (sampling defaults to 1).
    },
  });
  const pub = await app.inject({
    method: 'POST',
    url: `/v1/console/workflows/${id}/publish`,
    headers: { cookie },
    payload: {},
  });
  expect(pub.statusCode).toBe(200);
  // Force the SDK workflow cache to see the freshly-published workflow immediately.
  await app.workflowCache.refresh();
  return id;
}

describe('E2E: real Web SDK → real API → stored + reported (Testcontainers)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    __resetForTests();
    // Fresh Web Storage + IndexedDB per case so the SDK's caches/outbox start empty.
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
    const { IDBFactory } = await import('fake-indexeddb');
    globalThis.indexedDB = new IDBFactory();
    app = await buildApp(env, { db: t.db, closeDb: async () => {} });
  });

  it('signup → track → eligibility → submit → response stored + visible in reporting', async () => {
    const { publishableKey, cookie } = await signup(app);
    const eventName = 'checkout_completed';
    const workflowId = await publishWorkflow(app, cookie, eventName);
    const fetchImpl = injectFetch(app);

    // Drive the ACTUAL Web SDK. init + track run the real eligibility client.
    Signal.init(publishableKey, { apiUrl: 'http://api.local', fetchImpl, userId: 'e2e-user-1' });
    await Signal.track(eventName, { context: 'checkout' });
    await new Promise((r) => setTimeout(r, 30));

    // The overview shows exactly one trigger and, as yet, no response. A claimed
    // trigger is proof the SDK's eligibility call round-tripped a real config
    // server-side (the visual mount is DOM-suite territory; see the file header).
    const before = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${workflowId}/overview`,
      headers: { cookie },
    });
    expect(before.json().triggers).toBe(1);
    expect(before.json().responses).toBe(0);

    // Now submit a positive answer through the REAL SDK SheetHost (the precious
    // write path: Answer → ResponseBody mapping → durable outbox → POST
    // /v1/sdk/response). This is exactly the host web-core invokes when the user
    // taps a rating; web-core's UI tap itself is covered by the DOM suites, so
    // here we invoke the same `createWebHost(...).submit(answer)` to prove the
    // transport loop end to end.
    const { createWebHost } = await import('@ashish221/signal-web/webHost');
    const { Outbox } = await import('@ashish221/signal-web/outbox');
    const schema = await import('../src/db/schema.js');
    // Reuse the SAME trigger the SDK's eligibility call created server-side.
    const [trigger] = await t.db.select().from(schema.triggerLog);
    expect(trigger).toBeTruthy();
    const triggerId = trigger?.id as string;

    const host = createWebHost({
      apiUrl: 'http://api.local',
      publishableKey,
      outbox: new Outbox({ apiUrl: 'http://api.local', publishableKey, fetchImpl }),
      userId: 'e2e-user-1',
      eventName,
      triggerId,
      shownAt: new Date().toISOString(),
      fetchImpl,
    });
    await host.submit({ trigger_id: triggerId, rating_value: 3, positive: true });
    // Let the outbox flush (POST /v1/sdk/response) settle.
    await new Promise((r) => setTimeout(r, 50));

    // Assert the response is STORED and VISIBLE via the reporting endpoint.
    const after = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${workflowId}/overview`,
      headers: { cookie },
    });
    const overview = after.json();
    expect(overview.triggers).toBe(1);
    expect(overview.responses).toBe(1);
    expect(overview.positive_score).toBe(1); // rating 3 >= threshold 3 → positive

    // Idempotency (F2-D18 / B1 lineage): flushing the same trigger again is benign.
    const outbox2 = new Outbox({ apiUrl: 'http://api.local', publishableKey, fetchImpl });
    await outbox2.enqueue('response', {
      trigger_id: trigger?.id,
      rating_value: 3,
      device_os: 'web',
      app_version: '@signal/web@0.1.0',
      shown_at: new Date().toISOString(),
      responded_at: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 50));
    const afterReplay = await app.inject({
      method: 'GET',
      url: `/v1/console/workflows/${workflowId}/overview`,
      headers: { cookie },
    });
    expect(afterReplay.json().responses).toBe(1); // still one — server dedups on trigger_id
  });

  it('suppression: a second track after a response short-circuits (no new trigger)', async () => {
    const { publishableKey, cookie } = await signup(app);
    const eventName = 'checkout_completed';
    const workflowId = await publishWorkflow(app, cookie, eventName);
    const fetchImpl = injectFetch(app);

    Signal.init(publishableKey, { apiUrl: 'http://api.local', fetchImpl, userId: 'e2e-user-2' });
    await Signal.track(eventName);
    await new Promise((r) => setTimeout(r, 30));
    // First track claimed exactly one trigger.
    const schemaFirst = await import('../src/db/schema.js');
    expect((await t.db.select().from(schemaFirst.triggerLog)).length).toBe(1);

    // Submit through the REAL SheetHost — its `submit` records local suppression
    // (F2-D11) exactly as it does in the live UI flow.
    const schema = await import('../src/db/schema.js');
    const [trigger] = await t.db.select().from(schema.triggerLog);
    const triggerId = trigger?.id as string;
    const { createWebHost } = await import('@ashish221/signal-web/webHost');
    const { Outbox } = await import('@ashish221/signal-web/outbox');
    const host = createWebHost({
      apiUrl: 'http://api.local',
      publishableKey,
      outbox: new Outbox({ apiUrl: 'http://api.local', publishableKey, fetchImpl }),
      userId: 'e2e-user-2',
      eventName,
      triggerId,
      shownAt: new Date().toISOString(),
      fetchImpl,
    });
    await host.submit({ trigger_id: triggerId, rating_value: 3, positive: true });
    await new Promise((r) => setTimeout(r, 40));

    // The next track for the same (user,event) now short-circuits — no network,
    // no second eligibility claim — because the local suppression cache is warm
    // (F2-D11). Server-side proof: still exactly one trigger.
    await Signal.track(eventName);
    await new Promise((r) => setTimeout(r, 20));
    const [, second] = await t.db.select().from(schema.triggerLog);
    expect(second).toBeUndefined();
    void workflowId;
  });
});
