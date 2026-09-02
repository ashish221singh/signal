import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * CLI credential store (B3-D9): `~/.signal/config.json`. Holds the API URL and the
 * CLI token issued by `login`. Written 0600. `SIGNAL_CONFIG_DIR` overrides the
 * directory (used by tests to avoid touching the real home).
 */
export interface CliConfig {
  api_url: string;
  token?: string;
  scopes?: string[];
  expires_at?: string;
}

export function configDir(): string {
  return process.env.SIGNAL_CONFIG_DIR ?? join(homedir(), '.signal');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export async function readConfig(): Promise<CliConfig | null> {
  try {
    const raw = await readFile(configPath(), 'utf8');
    return JSON.parse(raw) as CliConfig;
  } catch {
    return null;
  }
}

export async function writeConfig(config: CliConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** Merge a partial update into the existing config (creating it if absent). */
export async function updateConfig(patch: Partial<CliConfig>): Promise<CliConfig> {
  const existing = (await readConfig()) ?? { api_url: defaultApiUrl() };
  const next = { ...existing, ...patch };
  await writeConfig(next);
  return next;
}

/** The hosted Signal API. Override with SIGNAL_API_URL (e.g. for local dev). */
export const DEFAULT_API_URL = 'https://signal-api-production-eca5.up.railway.app';

export function defaultApiUrl(): string {
  return process.env.SIGNAL_API_URL ?? DEFAULT_API_URL;
}
