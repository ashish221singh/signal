// apps/api/test/preview.int.test.ts
import { previewResponseSchema } from '@signal/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseEnv } from '../src/env.js';
import { mintPreviewToken } from '../src/preview/token.js';
import { seedAccountWithUser, startTestDb } from './testDb.js';

const env = parseEnv({ NODE_ENV: 'test' });

/** Create → complete → publish a workflow, returning its id. */
async function publishWorkflow(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  eventName = 'checkout_completed',
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
    },
  });
  const published = await app.inject({
    method: 'POST',
    url: `/v1/console/workflows/${id}/publish`,
    headers: { cookie },
    payload: {},
  });
  expect(published.statusCode).toBe(200);
  return id;
}

describe('hosted-link preview (F2-D16, real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    ({ userId } = await seedAccountWithUser(t.db));
    app = await buildApp(env, { db: t.db, closeDb: async () => {} });
    cookie = `signal_session=${app.signCookie(userId)}`;
  });
  afterEach(async () => {
    await app.close();
  });

  it('mint → GET renders the harness with the workflow config + bundle', async () => {
    const workflowId = await publishWorkflow(app, cookie);

    const mint = await app.inject({
      method: 'POST',
      url: '/v1/console/preview',
      headers: { cookie },
      payload: { workflow_id: workflowId },
    });
    expect(mint.statusCode).toBe(201);
    const body = mint.json();
    expect(previewResponseSchema.safeParse(body).success).toBe(true);
    expect(body.preview_url).toContain('/s/preview/');

    // The harness renders and embeds the config + the bundle <script>.
    const page = await app.inject({ method: 'GET', url: `/s/preview/${body.token}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('How was checkout?');
    expect(page.body).toContain('/s/preview/web-core.js');
    expect(page.body).toContain('not recorded'); // preview banner
    expect(page.body).toContain('SignalWebCore.mount');
  });

  it('serves the web-core IIFE bundle', async () => {
    const res = await app.inject({ method: 'GET', url: '/s/preview/web-core.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    // The IIFE global the harness mounts against.
    expect(res.body).toContain('SignalWebCore');
  });

  it('an expired token → friendly 404', async () => {
    const workflowId = await publishWorkflow(app, cookie);
    // Mint a token issued 40 min ago (past the 30-min TTL). The expiry check
    // rejects before any account lookup, so the account_id is immaterial here.
    const past = Date.now() - 40 * 60 * 1000;
    const { token } = mintPreviewToken(
      { account_id: '00000000-0000-4000-8000-0000000000aa', workflow_id: workflowId },
      env.SESSION_SECRET,
      30 * 60,
      past,
    );
    const page = await app.inject({ method: 'GET', url: `/s/preview/${token}` });
    expect(page.statusCode).toBe(404);
    expect(page.body).toContain('expired');
  });

  it('a token for another account cannot render this account’s workflow', async () => {
    const workflowId = await publishWorkflow(app, cookie);
    // Forge a *validly signed* token but with a different account_id — the
    // account-scoped lookup must miss → 404 (isolation).
    const { token } = mintPreviewToken(
      { account_id: '00000000-0000-4000-8000-0000000000ff', workflow_id: workflowId },
      env.SESSION_SECRET,
    );
    const page = await app.inject({ method: 'GET', url: `/s/preview/${token}` });
    expect(page.statusCode).toBe(404);
  });

  it('minting requires auth (no cookie/token → 401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/console/preview',
      payload: { workflow_id: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('minting a workflow the account does not own → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/console/preview',
      headers: { cookie },
      payload: { workflow_id: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(404);
  });
});
