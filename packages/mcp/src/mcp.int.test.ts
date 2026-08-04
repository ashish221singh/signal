import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildApp } from '@signal/api/app';
import { parseEnv } from '@signal/api/env';
import { seedAccountWithUser, startTestDb } from '@signal/api/test-helpers';
import { TokenService } from '@signal/api/tokens';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SignalApiClient } from './client.js';
import { buildMcpServer } from './server.js';

const env = parseEnv({ NODE_ENV: 'test' });

/**
 * MCP round-trip (B3-D8): drive the real MCP server over the in-memory transport,
 * backed by a `SignalApiClient` whose fetch is routed into the ephemeral Fastify app
 * via `inject` (no port needed). Proves create → publish → get_overview works through
 * the tool surface, inheriting the API's validation + isolation.
 */
function injectFetch(app: Awaited<ReturnType<typeof buildApp>>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: u.pathname + u.search,
      headers: init?.headers as Record<string, string>,
      payload: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      text: async () => res.body,
    } as Response;
  }) as unknown as typeof fetch;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  const text = res.content[0]?.text ?? '{}';
  return { isError: Boolean(res.isError), data: JSON.parse(text) };
}

describe('@signal/mcp round-trip (real Postgres + ephemeral API)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let client: Client;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    const seeded = await seedAccountWithUser(t.db, { email: 'mcp@example.com' });
    const token = (await new TokenService(t.db).issue(seeded.accountId, 'mcp')).token;
    app = await buildApp(env, { db: t.db, closeDb: async () => {} });

    const apiClient = new SignalApiClient('http://api.local', token, injectFetch(app));
    const server = buildMcpServer(apiClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
  });

  it('exposes the expected tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name).sort();
    expect(names).toEqual(
      [
        'create_workflow',
        'get_overview',
        'get_responses',
        'get_workflow',
        'list_events',
        'list_workflows',
        'pause_workflow',
        'publish_workflow',
        'set_rules',
        'update_workflow',
      ].sort(),
    );
  });

  it('create → publish → get_overview round-trips', async () => {
    const created = await callTool(client, 'create_workflow', {
      event_name: 'checkout_completed',
      metric_type: 'CSAT',
      rating_type: 'star',
      rating_scale_max: 5,
      header_text: 'How was checkout?',
      positive_threshold: 4,
    });
    expect(created.isError).toBe(false);
    const id = created.data.id;
    expect(id).toBeTruthy();
    expect(created.data.event_name).toBe('checkout_completed');

    const published = await callTool(client, 'publish_workflow', { id });
    expect(published.isError).toBe(false);
    expect(published.data.status).toBe('active');

    const overview = await callTool(client, 'get_overview', { id });
    expect(overview.isError).toBe(false);
    expect(overview.data.workflow_id ?? overview.data.campaign_id).toBe(id);
    expect(overview.data.triggers).toBe(0);
    expect(overview.data.responses).toBe(0);

    const list = await callTool(client, 'list_workflows', {});
    expect(list.data.map((w: { id: string }) => w.id)).toContain(id);
  });

  // B5-D4: onPositive/onNegative map to the API's positive_action/negative_action.
  it('create_workflow sets branched actions via onPositive/onNegative', async () => {
    const created = await callTool(client, 'create_workflow', {
      event_name: 'checkout_completed',
      header_text: 'How was checkout?',
      onPositive: { type: 'store_review' },
      onNegative: { type: 'redirect', url: 'https://support.example.com' },
    });
    expect(created.isError).toBe(false);
    expect(created.data.positive_action).toEqual({ type: 'store_review' });
    expect(created.data.negative_action).toEqual({
      type: 'redirect',
      url: 'https://support.example.com',
    });
  });

  it('surfaces API errors as isError with the server code', async () => {
    // Publishing an incomplete workflow → 422 incomplete.
    const created = await callTool(client, 'create_workflow', { event_name: 'x' });
    const publish = await callTool(client, 'publish_workflow', { id: created.data.id });
    expect(publish.isError).toBe(true);
    expect(publish.data.error.code).toBe('incomplete');
  });

  it('set_rules updates sampling and gating', async () => {
    const created = await callTool(client, 'create_workflow', { event_name: 'e' });
    const ruled = await callTool(client, 'set_rules', {
      id: created.data.id,
      sampling_rate: 0.5,
      min_session_age_days: 7,
    });
    expect(ruled.data.sampling_rate).toBe(0.5);
    expect(ruled.data.min_session_age_days).toBe(7);
  });
});
