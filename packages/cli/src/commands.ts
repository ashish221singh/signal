import { spawn } from 'node:child_process';
import type { DeployItemResult } from '@signal/contracts';
import type { CliClient } from './client.js';
import { defaultApiUrl, readConfig, updateConfig } from './config.js';
import { loadDeployConfig } from './loadConfigFile.js';

/** Best-effort open a URL in the user's browser (macOS/Linux/Windows). Never throws.
 *  No-op when not attached to an interactive terminal (tests, pipes, CI) or when
 *  SIGNAL_NO_BROWSER=1 — the printed link is always the fallback. */
function openBrowser(url: string): void {
  if (process.env.SIGNAL_NO_BROWSER === '1' || !process.stdout.isTTY) return;
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
  } catch {
    /* headless / no browser — the printed link is the fallback */
  }
}

/**
 * CLI command implementations (B3-D9), decoupled from commander so they are directly
 * unit/e2e-testable. Each takes a `CliClient` factory + an output sink. `login`
 * (device flow) and `login --password` both persist the token to
 * `~/.signal/config.json`; the others read it back and require it.
 */
export interface CommandDeps {
  makeClient: (apiUrl: string) => CliClient;
  out: (line: string) => void;
  /** Sleep between device-flow polls (overridable so tests don't wait). */
  sleep?: (ms: number) => Promise<void>;
  /** Bounds the device-flow poll loop (tests keep it small). */
  maxPolls?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function requireToken(): Promise<{ apiUrl: string; token: string }> {
  const config = await readConfig();
  if (!config?.token) {
    throw new Error('not logged in — run `signal login` first');
  }
  return { apiUrl: config.api_url ?? defaultApiUrl(), token: config.token };
}

/** `signal login` — device flow. Prints the verification URL, then polls. */
export async function loginDevice(deps: CommandDeps, apiUrl = defaultApiUrl()): Promise<void> {
  const client = deps.makeClient(apiUrl);
  const grant = await client.startDevice();
  deps.out('Opening your browser to authorize this CLI…');
  deps.out(`If it doesn’t open, visit:\n  ${grant.verification_uri}`);
  deps.out(`and confirm the code:  ${grant.user_code}`);
  openBrowser(grant.verification_uri);

  const sleep = deps.sleep ?? defaultSleep;
  const maxPolls = deps.maxPolls ?? Math.ceil(grant.expires_in / grant.interval);
  for (let i = 0; i < maxPolls; i++) {
    const poll = await client.pollDevice(grant.device_code);
    if (poll.status === 'approved') {
      await updateConfig({
        api_url: apiUrl,
        token: poll.result.token,
        scopes: poll.result.scopes,
        expires_at: String(poll.result.expires_at),
      });
      deps.out('Logged in. Token saved to ~/.signal/config.json');
      return;
    }
    if (poll.status === 'denied') throw new Error('authorization was denied');
    if (poll.status === 'expired') throw new Error('the device code expired — run login again');
    await sleep(grant.interval * 1000);
  }
  throw new Error('timed out waiting for approval');
}

/** `signal login --password` — interim credential login. */
export async function loginPassword(
  deps: CommandDeps,
  email: string,
  password: string,
  apiUrl = defaultApiUrl(),
): Promise<void> {
  const client = deps.makeClient(apiUrl);
  const result = await client.passwordLogin(email, password);
  await updateConfig({
    api_url: apiUrl,
    token: result.token,
    scopes: result.scopes,
    expires_at: String(result.expires_at),
  });
  deps.out('Logged in. Token saved to ~/.signal/config.json');
}

/**
 * `signal login --token <cli_…>` (F3) — save a CLI token minted from the dashboard.
 * The dashboard (Clerk-authed) generates it under your account; this bridges the CLI
 * to that account without a separate device-flow/password login.
 */
export async function loginToken(
  deps: CommandDeps,
  token: string,
  apiUrl = defaultApiUrl(),
): Promise<void> {
  if (!token.startsWith('cli_')) {
    throw new Error('that does not look like a CLI token (expected it to start with `cli_`)');
  }
  await updateConfig({ api_url: apiUrl, token });
  deps.out('Logged in. Token saved to ~/.signal/config.json');
}

/** `signal whoami` — show the stored login (account is implied by the token). */
export async function whoami(deps: CommandDeps): Promise<void> {
  const config = await readConfig();
  if (!config?.token) {
    deps.out('Not logged in.');
    return;
  }
  const client = deps.makeClient(config.api_url ?? defaultApiUrl());
  // A round-trip both proves the token is live and confirms the API URL.
  await client.listWorkflows(config.token);
  deps.out(`Logged in to ${config.api_url}`);
  deps.out(`Scopes: ${(config.scopes ?? []).join(', ') || '(unknown)'}`);
  deps.out(`Token expires: ${config.expires_at ?? '(unknown)'}`);
}

/** `signal deploy <file>` — apply a config-as-code file, printing per-item results. */
export async function deploy(deps: CommandDeps, file: string): Promise<DeployItemResult[]> {
  const { apiUrl, token } = await requireToken();
  const config = await loadDeployConfig(file);
  const client = deps.makeClient(apiUrl);
  const { results } = await client.deploy(token, config.workflows);
  for (const r of results) {
    const suffix = r.error ? ` — ${r.error.code}: ${r.error.message}` : '';
    deps.out(`${r.action.padEnd(9)} ${r.key} (${r.status ?? '—'})${suffix}`);
  }
  const failed = results.filter((r) => r.action === 'failed');
  if (failed.length > 0) {
    deps.out(`\n${failed.length} item(s) failed.`);
  }
  return results;
}

/** `signal workflows list` — list the account's workflows. */
export async function workflowsList(deps: CommandDeps): Promise<void> {
  const { apiUrl, token } = await requireToken();
  const client = deps.makeClient(apiUrl);
  const rows = (await client.listWorkflows(token)) as {
    id: string;
    event_name: string | null;
    header_text: string | null;
    status: string;
  }[];
  if (rows.length === 0) {
    deps.out('No workflows.');
    return;
  }
  for (const w of rows) {
    deps.out(`${w.status.padEnd(8)} ${w.event_name ?? '(no event)'}  ${w.id}`);
  }
}

/**
 * Resolve the account's publishable key for `signal init` when none is passed (F3),
 * so `npx @signal/cli init` is a true one-liner. Logs in via the device flow if
 * needed, then picks the default live key (falling back to any live/non-revoked key).
 */
export async function autoResolveKey(deps: CommandDeps, apiUrl = defaultApiUrl()): Promise<string> {
  let config = await readConfig();
  if (!config?.token) {
    deps.out('Not logged in — starting login first.\n');
    await loginDevice(deps, apiUrl);
    config = await readConfig();
  }
  if (!config?.token) throw new Error('login is required to fetch your publishable key');

  const client = deps.makeClient(config.api_url ?? apiUrl);
  const { keys } = await client.listKeys(config.token);
  const live = keys.filter((k) => !k.revoked_at && k.environment === 'live');
  const chosen =
    live.find((k) => k.label === 'default') ?? live[0] ?? keys.find((k) => !k.revoked_at);
  if (!chosen) throw new Error('no publishable key found for your account');
  return chosen.key;
}
