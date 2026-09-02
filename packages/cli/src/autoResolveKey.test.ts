import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliClient } from './client.js';
import { autoResolveKey, type CommandDeps } from './commands.js';
import { writeConfig } from './config.js';

type Key = { key: string; label: string; environment: string; revoked_at: string | null };

function depsWithKeys(keys: Key[]): CommandDeps {
  return {
    out: () => {},
    makeClient: () => ({ listKeys: async () => ({ keys }) }) as unknown as CliClient,
  };
}

describe('autoResolveKey (signal init auto-fetch)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'signal-cli-'));
    process.env.SIGNAL_CONFIG_DIR = dir;
    await writeConfig({ api_url: 'http://localhost:3000', token: 'cli_test' });
  });
  afterEach(async () => {
    delete process.env.SIGNAL_CONFIG_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('prefers the default live key, skipping revoked ones', async () => {
    const deps = depsWithKeys([
      { key: 'pk_old', label: 'default', environment: 'live', revoked_at: '2026-01-01' },
      { key: 'pk_live_default', label: 'default', environment: 'live', revoked_at: null },
      { key: 'pk_other', label: 'ci', environment: 'live', revoked_at: null },
    ]);
    expect(await autoResolveKey(deps)).toBe('pk_live_default');
  });

  it('falls back to any live key when there is no "default"', async () => {
    const deps = depsWithKeys([
      { key: 'pk_only', label: 'ci', environment: 'live', revoked_at: null },
    ]);
    expect(await autoResolveKey(deps)).toBe('pk_only');
  });

  it('throws when the account has no usable key', async () => {
    const deps = depsWithKeys([
      { key: 'pk_dead', label: 'default', environment: 'live', revoked_at: '2026-01-01' },
    ]);
    await expect(autoResolveKey(deps)).rejects.toThrow(/no publishable key/);
  });
});
