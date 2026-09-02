import { autoResolveKey, type CommandDeps } from './commands.js';
import { defaultApiUrl } from './config.js';
import { runInit } from './init.js';
import { type AskFn, runSetup } from './setup.js';

/**
 * `signal quickstart` — the whole terminal path in one command. It chains the three
 * steps a non-agent user would otherwise run separately:
 *   1. log in (device flow if needed) and resolve the account's publishable key,
 *   2. `setup` — interview + create/publish a feedback workflow,
 *   3. `init` — install the Web SDK and wire `Signal.init(key)` into the project.
 * Then it prints the one `Signal.track('<event>')` line to add. This is the CLI twin
 * of `connect` (which hands the same three steps to a coding agent).
 */
export async function runQuickstart(
  deps: CommandDeps,
  ask: AskFn,
  dir: string,
  apiUrl = defaultApiUrl(),
): Promise<void> {
  deps.out('Signal quickstart — log in, configure feedback, and wire your app.');
  deps.out('');

  // 1) Login + key. autoResolveKey runs the device flow when not logged in and
  //    returns the account's default live publishable key.
  const key = await autoResolveKey(deps, apiUrl);

  // 2) Configure the feedback workflow (interactive interview).
  deps.out('');
  deps.out('── Step 1 of 2 · Configure your feedback ──────────────');
  const { eventName } = await runSetup(deps, ask);

  // 3) Wire the SDK into this project.
  deps.out('');
  deps.out('── Step 2 of 2 · Wire the SDK into this project ───────');
  await runInit(dir, key, deps.out);

  // Consolidated close — the one line that bridges the two halves.
  deps.out('');
  deps.out('✓ Done. Last thing — record the moment in your code:');
  deps.out(`  Signal.track('${eventName}');`);
  deps.out('Trigger that once and the feedback ask appears; responses land on your dashboard.');
}
