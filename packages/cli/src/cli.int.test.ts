import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '@signal/api/app';
import { parseEnv } from '@signal/api/env';
import { hashPassword } from '@signal/api/password';
import { seedAccount, startTestDb } from '@signal/api/test-helpers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CliClient } from './client.js';
import type { CommandDeps } from './commands.js';
import { deploy, loginDevice, loginPassword, whoami, workflowsList } from './commands.js';
import { readConfig } from './config.js';
import { runSetup } from './setup.js';

const env = parseEnv({ NODE_ENV: 'test' });
const FIXTURE = fileURLToPath(new URL('../test/fixtures/signal.config.ts', import.meta.url));

const EMAIL = 'cli@example.com';
const PASSWORD = 'supersecret';

/** Route a CliClient's fetch into the ephemeral Fastify app (no port). */
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

describe('@signal/cli e2e (real Postgres + ephemeral API)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let configDir: string;
  let out: string[];
  let deps: CommandDeps;

  beforeAll(async () => {
    t = await startTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.stop();
  });

  beforeEach(async () => {
    await t.truncateAll();
    const accountId = await seedAccount(t.db);
    const schema = await import('@signal/api/schema');
    await t.db.insert(schema.consoleUsers).values({
      accountId,
      email: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      name: 'CLI User',
      role: 'admin',
    });

    app = await buildApp(env, { db: t.db, closeDb: async () => {} });
    configDir = await mkdtemp(join(tmpdir(), 'signal-cli-'));
    process.env.SIGNAL_CONFIG_DIR = configDir;
    out = [];
    deps = {
      makeClient: (apiUrl) => new CliClient(apiUrl, injectFetch(app)),
      out: (line) => out.push(line),
      sleep: async () => {},
      maxPolls: 5,
    };
  });

  afterEach(async () => {
    await app.close();
    await rm(configDir, { recursive: true, force: true });
    process.env.SIGNAL_CONFIG_DIR = undefined;
  });

  it('login --password → deploy fixture → workflows list shows it', async () => {
    await loginPassword(deps, EMAIL, PASSWORD, 'http://api.local');
    const config = await readConfig();
    expect(config?.token).toMatch(/^cli_/);

    const results = await deploy(deps, FIXTURE);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ key: 'checkout-csat', action: 'created', status: 'active' });

    out = [];
    await workflowsList(deps);
    const joined = out.join('\n');
    expect(joined).toContain('checkout_completed');
    expect(joined).toContain('active');
  });

  it('setup wizard interviews → creates + publishes an active branched workflow', async () => {
    await loginPassword(deps, EMAIL, PASSWORD, 'http://api.local');
    // Scripted answers in the wizard's question order (no TTY needed).
    const answers = [
      'checkout_completed', // event_name
      'CSAT', // metric_type
      'star', // rating_type (⇒ scale 5)
      'How was checkout?', // header_text
      '4', // positive_threshold
      'yes', // other_allows_image
      'store_review', // positive_action
      'redirect', // negative_action
      'https://support.acme.com', //   redirect url
      'after_7_days', // ask_frequency
    ];
    let i = 0;
    const ask = async () => answers[i++] ?? '';

    const result = await runSetup(deps, ask);
    expect(result.status).toBe('active');

    const schema = await import('@signal/api/schema');
    const [row] = await t.db.select().from(schema.workflows);
    expect(row?.status).toBe('active');
    expect(row?.eventName).toBe('checkout_completed');
    expect(row?.ratingType).toBe('star');
    expect(row?.ratingScaleMax).toBe(5);
    expect(row?.positiveThreshold).toBe(4);
    expect(row?.otherAllowsImage).toBe(true);
    expect(row?.positiveAction).toEqual({ type: 'store_review' });
    expect(row?.negativeAction).toEqual({ type: 'redirect', url: 'https://support.acme.com' });
  });

  it('whoami reports the login', async () => {
    await loginPassword(deps, EMAIL, PASSWORD, 'http://api.local');
    out = [];
    await whoami(deps);
    expect(out.join('\n')).toContain('Logged in to http://api.local');
  });

  it('deploy without login fails clearly', async () => {
    await expect(deploy(deps, FIXTURE)).rejects.toThrow(/not logged in/);
  });

  it('login via the device flow (approve out-of-band) persists a token', async () => {
    const schema = await import('@signal/api/schema');

    // Get a session cookie to approve with.
    const login = await app.inject({
      method: 'POST',
      url: '/v1/console/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    });
    const setCookie = login.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
      .find((c) => c?.startsWith('signal_session='))
      ?.split(';')[0] as string;

    // Run the CLI device login; concurrently discover the pending user_code it
    // created (printed to `out` / stored in the DB) and approve it, mimicking the
    // human opening the browser.
    const loginPromise = loginDevice(
      { ...deps, maxPolls: 50, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))) },
      'http://api.local',
    );

    // Poll the DB for the pending authorization, then approve it.
    for (let i = 0; i < 50; i++) {
      const [row] = await t.db.select().from(schema.deviceAuthorizations);
      if (row) {
        await app.inject({
          method: 'POST',
          url: '/cli/approve',
          headers: { cookie },
          payload: { user_code: row.userCode, decision: 'approve' },
        });
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }

    await loginPromise;
    const config = await readConfig();
    expect(config?.token).toMatch(/^cli_/);
    expect(out.join('\n')).toContain('Logged in');
  });
});
