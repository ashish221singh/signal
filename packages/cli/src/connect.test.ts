import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliClient } from './client.js';
import type { CommandDeps } from './commands.js';
import { writeConfig } from './config.js';
import { AGENT_TARGETS, MCP_PACKAGE, runConnect, signalMcpEntry } from './connect.js';

function collectingDeps(lines: string[]): CommandDeps {
  return {
    out: (line) => lines.push(line),
    makeClient: () => ({}) as unknown as CliClient,
  };
}

const API = 'https://api.example.test';

describe('runConnect (signal connect — wire the MCP into an agent)', () => {
  let dir: string;
  let cfgDir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'signal-connect-'));
    cfgDir = await mkdtemp(join(tmpdir(), 'signal-cfg-'));
    process.env.SIGNAL_CONFIG_DIR = cfgDir;
    await writeConfig({ api_url: API, token: 'cli_stored_token' });
  });
  afterEach(async () => {
    delete process.env.SIGNAL_CONFIG_DIR;
    await rm(dir, { recursive: true, force: true });
    await rm(cfgDir, { recursive: true, force: true });
  });

  it('writes an mcpServers.signal entry to .mcp.json for Claude Code by default', async () => {
    const lines: string[] = [];
    const path = await runConnect(collectingDeps(lines), { dir, agent: 'claude', apiUrl: API });

    expect(path).toBe(join(dir, '.mcp.json'));
    const cfg = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(cfg.mcpServers.signal).toEqual({
      command: 'npx',
      args: ['-y', MCP_PACKAGE],
      env: { SIGNAL_TOKEN: 'cli_stored_token', SIGNAL_API_URL: API },
    });
    expect(lines.join('\n')).toMatch(/Set up Signal feedback/);
  });

  it('uses the stored token from config when none is passed', async () => {
    await runConnect(collectingDeps([]), { dir, agent: 'cursor', apiUrl: API });
    const cursorFile = AGENT_TARGETS.cursor?.file ?? '';
    const cfg = JSON.parse(await readFile(join(dir, cursorFile), 'utf8'));
    expect(cfg.mcpServers.signal.env.SIGNAL_TOKEN).toBe('cli_stored_token');
  });

  it('merges into an existing config without clobbering other servers', async () => {
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'foo' } }, extra: true }),
    );
    await runConnect(collectingDeps([]), { dir, agent: 'claude', apiUrl: API, token: 'cli_x' });

    const cfg = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(cfg.mcpServers.other).toEqual({ command: 'foo' });
    expect(cfg.mcpServers.signal).toBeDefined();
    expect(cfg.extra).toBe(true);
  });

  it('--print emits the config block and writes no file', async () => {
    const lines: string[] = [];
    const path = await runConnect(collectingDeps(lines), {
      dir,
      agent: 'claude',
      apiUrl: API,
      print: true,
      token: 'cli_p',
    });
    expect(path).toBeNull();
    const printed = lines.join('\n');
    expect(printed).toMatch(/mcpServers/);
    expect(printed).toContain('cli_p');
    await expect(readFile(join(dir, '.mcp.json'), 'utf8')).rejects.toThrow();
  });

  it('rejects an unknown agent', async () => {
    await expect(
      runConnect(collectingDeps([]), { dir, agent: 'emacs', apiUrl: API, token: 'cli_x' }),
    ).rejects.toThrow(/unknown agent/);
  });

  it('signalMcpEntry bakes in the token and api url', () => {
    expect(signalMcpEntry('cli_z', API).env).toEqual({
      SIGNAL_TOKEN: 'cli_z',
      SIGNAL_API_URL: API,
    });
  });
});
