import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { deployRequestSchema } from '@signal/contracts';

/**
 * Load a `signal.config.{ts,js,mjs,json}` deploy file (B3-D9). A `.json` file is
 * parsed directly; a module file is dynamically imported and its default export (or
 * a top-level `workflows`) is used. The result is validated against
 * `deployRequestSchema`, so a malformed file fails before any API call.
 *
 * A `.ts` file requires the process to understand TypeScript (run via `tsx`, or the
 * test runner). The CLI's `bin` is a `.ts` shebang, so `npx tsx signal deploy` works.
 */
export async function loadDeployConfig(
  path: string,
): Promise<{ workflows: import('@signal/contracts').DeployWorkflow[] }> {
  let raw: unknown;
  if (path.endsWith('.json')) {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } else {
    const mod = (await import(pathToFileURL(path).href)) as {
      default?: unknown;
      workflows?: unknown;
    };
    const candidate = mod.default ?? mod;
    raw =
      candidate && typeof candidate === 'object' && 'workflows' in candidate
        ? candidate
        : { workflows: mod.workflows };
  }

  const parsed = deployRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid deploy config: ${detail}`);
  }
  return parsed.data;
}
