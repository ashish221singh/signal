import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliClient } from './client.js';
import type { CommandDeps } from './commands.js';
import { writeConfig } from './config.js';
import { WEB_SDK_DEP } from './init.js';
import { runQuickstart } from './quickstart.js';
import type { AskFn } from './setup.js';

const API = 'https://api.example.test';

/** A CliClient stub covering the calls quickstart makes (key resolve + setup). */
function stubClient(calls: { patched?: Record<string, unknown> }): CliClient {
  return {
    listKeys: async () => ({
      keys: [{ key: 'pk_live_x', label: 'default', environment: 'live', revoked_at: null }],
    }),
    createWorkflow: async () => ({ id: 'wf_1' }),
    patchWorkflow: async (_t: string, _id: string, patch: Record<string, unknown>) => {
      calls.patched = patch;
      return {};
    },
    publishWorkflow: async () => ({ status: 'active' }),
  } as unknown as CliClient;
}

/** Scripted answers for the setup interview, in the order runSetup asks. */
function scriptedAsk(answers: string[]): AskFn {
  let i = 0;
  return async () => answers[i++] ?? '';
}

describe('runQuickstart (login → setup → init in one command)', () => {
  let dir: string;
  let cfgDir: string;
  let out: string[];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'signal-qs-'));
    cfgDir = await mkdtemp(join(tmpdir(), 'signal-qs-cfg-'));
    process.env.SIGNAL_CONFIG_DIR = cfgDir;
    out = [];
    // Already logged in so autoResolveKey skips the device flow.
    await writeConfig({ api_url: API, token: 'cli_stored' });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'shop' }, null, 2));
  });
  afterEach(async () => {
    delete process.env.SIGNAL_CONFIG_DIR;
    await rm(dir, { recursive: true, force: true });
    await rm(cfgDir, { recursive: true, force: true });
  });

  it('publishes a workflow AND wires the SDK, then prints the track line', async () => {
    const calls: { patched?: Record<string, unknown> } = {};
    const deps: CommandDeps = {
      out: (l) => out.push(l),
      makeClient: () => stubClient(calls),
    };
    const ask = scriptedAsk([
      'checkout_completed', // event_name
      'CSAT', // metric_type
      'star', // rating_type
      'How was checkout?', // header_text
      '4', // positive_threshold
      'no', // other_allows_image
      'none', // positive_action
      'none', // negative_action
      'after_7_days', // ask_frequency
    ]);

    await runQuickstart(deps, ask, dir, API);

    // 1) setup ran: the workflow was patched with the event + published.
    expect(calls.patched?.event_name).toBe('checkout_completed');

    // 2) init ran: dep added + snippet written with the resolved key.
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(pkg.dependencies[WEB_SDK_DEP]).toBeTruthy();
    const snippet = await readFile(join(dir, 'signal-setup.js'), 'utf8');
    expect(snippet).toContain("Signal.init('pk_live_x'");

    // 3) consolidated close names the real event in the track line.
    expect(out.join('\n')).toContain("Signal.track('checkout_completed')");
  });
});
