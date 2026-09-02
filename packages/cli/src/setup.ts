import { SETUP_FIELDS, type SetupField, type SetupFieldOption } from '@signal/contracts';
import { type CommandDeps, requireToken } from './commands.js';

/**
 * `signal setup` — the interactive, non-agent fallback for creating a workflow. It
 * walks the shared SETUP_FIELDS guide, asking the same questions an AI agent would,
 * then create → patch → publishes through the console API. The prompt function is
 * injected so it's driveable from a test without a TTY.
 */
export type AskFn = (question: string, options?: readonly SetupFieldOption[]) => Promise<string>;

export interface WorkflowAction {
  type: 'none' | 'thanks' | 'redirect' | 'store_review';
  message?: string;
  url?: string;
}

function field(key: string): SetupField {
  const f = SETUP_FIELDS.find((x) => x.key === key);
  if (!f) throw new Error(`unknown setup field: ${key}`);
  return f;
}

/** Normalize a free-text answer to one of `allowed`, else the fallback. */
function pick<T extends string>(answer: string, allowed: readonly T[], fallback: T): T {
  const a = answer.trim().toLowerCase();
  return allowed.find((v) => v.toLowerCase() === a) ?? fallback;
}

function yesNo(answer: string, fallback = false): boolean {
  const a = answer.trim().toLowerCase();
  if (/^(y|yes|true|1)$/.test(a)) return true;
  if (/^(n|no|false|0)$/.test(a)) return false;
  return fallback;
}

function clampInt(answer: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(answer.trim(), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

async function askAction(ask: AskFn, key: string): Promise<WorkflowAction> {
  const f = field(key);
  const type = pick(
    await ask(f.question, f.options),
    ['none', 'thanks', 'redirect', 'store_review'] as const,
    'none',
  );
  if (type === 'redirect') {
    const url = (await ask('  Redirect to which https:// URL?')).trim();
    return { type, url };
  }
  if (type === 'thanks') {
    const message = (await ask('  Thank-you message? (blank for default)')).trim();
    return message ? { type, message } : { type };
  }
  return { type };
}

export async function runSetup(
  deps: CommandDeps,
  ask: AskFn,
): Promise<{ id: string; status: string; eventName: string }> {
  const { apiUrl, token } = await requireToken();
  const client = deps.makeClient(apiUrl);
  const patch: Record<string, unknown> = {};

  patch.event_name = (await ask(field('event_name').question, field('event_name').options)).trim();
  patch.metric_type = pick(
    await ask(field('metric_type').question, field('metric_type').options),
    ['CSAT', 'CES'] as const,
    'CSAT',
  );

  const ratingType = pick(
    await ask(field('rating_type').question, field('rating_type').options),
    ['star', 'emoji', 'effort_scale'] as const,
    'star',
  );
  patch.rating_type = ratingType;
  // Scale is derived from the rating type (emoji ⇒ 3, star/effort ⇒ 5).
  const scaleMax = ratingType === 'emoji' ? 3 : 5;
  patch.rating_scale_max = scaleMax;

  patch.header_text = (await ask(field('header_text').question)).trim();
  patch.positive_threshold = clampInt(
    await ask(`${field('positive_threshold').question} (1–${scaleMax})`),
    1,
    scaleMax,
    scaleMax === 3 ? 3 : 4,
  );

  patch.other_allows_image = yesNo(
    await ask(field('other_allows_image').question, field('other_allows_image').options),
  );
  patch.positive_action = await askAction(ask, 'positive_action');
  patch.negative_action = await askAction(ask, 'negative_action');
  patch.ask_frequency = pick(
    await ask(field('ask_frequency').question, field('ask_frequency').options),
    ['after_7_days', 'after_30_days', 'after_60_days'] as const,
    'after_7_days',
  );

  const created = await client.createWorkflow(token);
  await client.patchWorkflow(token, created.id, patch);
  const published = await client.publishWorkflow(token, created.id);
  const status = published.status ?? 'active';
  deps.out(`✓ workflow ${created.id} for "${patch.event_name}" is ${status}`);
  // Non-agent users wire the event themselves — print the exact one line to add.
  // (An AI agent using the MCP tools inserts this call into the code directly.)
  deps.out('');
  deps.out('Add this where the moment happens in your code:');
  deps.out(`  Signal.track('${patch.event_name}');`);
  deps.out('Responses will show up on your dashboard at /app/dashboard.');
  return { id: created.id, status, eventName: String(patch.event_name) };
}
