import type { DeployItemResult, DeployWorkflow } from '@signal/contracts';
import { type CommandDeps, requireToken } from './commands.js';

/**
 * `signal setup` (F3) — the NON-agent path to defining a feedback ask. The
 * interactive wizard in `index.ts` collects these answers over readline; the core
 * (`buildWorkflow` + `runSetup`) is decoupled so it's unit-testable. Agent users get
 * the equivalent via the MCP server, but both converge on the same deploy payload.
 */
export interface SetupAnswers {
  /** The named moment the ask fires (e.g. `checkout_completed`). */
  eventName: string;
  /** The question shown to the user. */
  question: string;
  /** Rating input: 5-star or 3-emoji (CSAT only — CES was dropped). */
  ratingType: 'star' | 'emoji';
  /** Rating at/above which a response counts as positive. */
  positiveThreshold: number;
  /** Reason chips offered on a negative rating (may be empty). */
  chips: string[];
}

/** Default "positive" threshold for a rating type (4/5 stars, 3/3 emoji). */
export function defaultThreshold(ratingType: 'star' | 'emoji'): number {
  return ratingType === 'star' ? 4 : 3;
}

/** Derive a stable, slug-like deploy `key` from the event name. */
export function toKey(eventName: string): string {
  const slug = eventName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'feedback';
}

/** Turn wizard answers into a valid single-workflow deploy payload. */
export function buildWorkflow(a: SetupAnswers): DeployWorkflow {
  return {
    key: toKey(a.eventName),
    event_name: a.eventName.trim(),
    status: 'active',
    metric_type: 'CSAT',
    rating_type: a.ratingType,
    rating_scale_max: a.ratingType === 'star' ? 5 : 3,
    header_text: a.question.trim(),
    positive_threshold: a.positiveThreshold,
    chips_on_negative: a.chips,
    sampling_rate: 1,
  };
}

/** The one line of code the user adds to fire the ask (non-agent: they paste it). */
export function trackSnippet(eventName: string): string {
  return `Signal.track('${eventName.trim()}');`;
}

/**
 * Deploy the configured ask live and print the outcome + the `track()` snippet to
 * add. Requires a logged-in CLI (`signal login`). Returns the deploy results.
 */
export async function runSetup(
  deps: CommandDeps,
  answers: SetupAnswers,
): Promise<DeployItemResult[]> {
  const { apiUrl, token } = await requireToken();
  const client = deps.makeClient(apiUrl);
  const workflow = buildWorkflow(answers);
  const { results } = await client.deploy(token, [workflow]);

  for (const r of results) {
    const suffix = r.error ? ` — ${r.error.code}: ${r.error.message}` : '';
    deps.out(`${r.action.padEnd(9)} ${r.key} (${r.status ?? '—'})${suffix}`);
  }

  const ok = results.every((r) => r.action !== 'failed');
  if (ok) {
    deps.out('');
    deps.out('Add this where the moment happens in your code:');
    deps.out(`  ${trackSnippet(answers.eventName)}`);
    deps.out('');
    deps.out('Responses will show up on your dashboard at /app/dashboard.');
  }
  return results;
}
