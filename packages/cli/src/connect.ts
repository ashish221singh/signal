import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type CommandDeps, loginDevice } from './commands.js';
import { readConfig } from './config.js';

/**
 * `signal connect` (F4) — the one-liner that wires the Signal MCP server into a coding
 * agent so the agent can drive the whole setup by chat. It logs the user in (device
 * flow) if needed, then writes/merges an `mcpServers.signal` entry into the agent's
 * project-scoped MCP config with the user's CLI token baked in. After this, the user
 * just tells their agent: "set up Signal feedback".
 */

/** The npm package that hosts the Signal MCP stdio server (published, F3). */
export const MCP_PACKAGE = '@ashish221/signal-mcp';

interface AgentTarget {
  /** Project-relative path to the agent's MCP config file. */
  file: string;
  label: string;
}

/** Coding agents we can wire up. All share the `{ mcpServers: {...} }` schema. */
export const AGENT_TARGETS: Record<string, AgentTarget> = {
  claude: { file: '.mcp.json', label: 'Claude Code' },
  cursor: { file: join('.cursor', 'mcp.json'), label: 'Cursor' },
  windsurf: { file: join('.codeium', 'windsurf', 'mcp_config.json'), label: 'Windsurf' },
  vscode: { file: join('.vscode', 'mcp.json'), label: 'VS Code' },
};

/** The `mcpServers.signal` entry we merge in — an `npx` launch of the MCP package. */
export function signalMcpEntry(token: string, apiUrl: string): Record<string, unknown> {
  return {
    command: 'npx',
    args: ['-y', MCP_PACKAGE],
    env: { SIGNAL_TOKEN: token, SIGNAL_API_URL: apiUrl },
  };
}

/** Resolve a usable CLI token, logging in via the device flow if none is stored. */
export async function resolveToken(deps: CommandDeps, apiUrl: string): Promise<string> {
  let config = await readConfig();
  if (!config?.token) {
    deps.out('Not logged in — starting login first.\n');
    await loginDevice(deps, apiUrl);
    config = await readConfig();
  }
  if (!config?.token) throw new Error('login is required to connect your agent');
  return config.token;
}

/** Read an existing MCP config file, tolerating absence/empty/corrupt as `{}`. */
async function readMcpConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = (await readFile(path, 'utf8')).trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface ConnectOptions {
  dir: string;
  agent: string;
  apiUrl: string;
  /** Skip writing files; just print the config block for manual paste. */
  print?: boolean;
  /** Override token resolution (tests). */
  token?: string;
}

/**
 * Wire the Signal MCP into the chosen agent's project config (or print it with
 * `--print`). Returns the absolute path written, or null when only printing.
 */
export async function runConnect(deps: CommandDeps, opts: ConnectOptions): Promise<string | null> {
  const target = AGENT_TARGETS[opts.agent];
  if (!target) {
    const names = Object.keys(AGENT_TARGETS).join(', ');
    throw new Error(`unknown agent "${opts.agent}" — choose one of: ${names}`);
  }

  const token = opts.token ?? (await resolveToken(deps, opts.apiUrl));
  const entry = signalMcpEntry(token, opts.apiUrl);

  if (opts.print) {
    deps.out('Add this to your agent’s MCP config (mcpServers):\n');
    deps.out(JSON.stringify({ mcpServers: { signal: entry } }, null, 2));
    return null;
  }

  const path = join(opts.dir, target.file);
  const existing = await readMcpConfig(path);
  const servers = (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
  const next = { ...existing, mcpServers: { ...servers, signal: entry } };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });

  deps.out(`✓ Connected the Signal MCP to ${target.label} (${target.file}).`);
  deps.out('');
  deps.out('Next — just tell your coding agent:');
  deps.out('  “Set up Signal feedback for my app.”');
  deps.out('');
  deps.out('It will interview you (question + rating + reply chips), publish the workflow,');
  deps.out('and wire Signal.track() into your code. Restart your agent if it was open.');
  return path;
}
