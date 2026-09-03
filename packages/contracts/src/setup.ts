/**
 * Agent-guided setup guide (shared source of truth). One canonical description of
 * every workflow builder field — the human question to ask, the allowed options,
 * an example, and whether it's required to publish. Reused by:
 *
 * - the API, to attach human-readable `questions` to an `incomplete` publish (so even
 *   a minimal agent asks the right thing);
 * - the MCP `setup_workflow` prompt, to hand an AI agent a ready interview script;
 * - the `signal setup` CLI wizard, to drive an interactive terminal setup.
 *
 * Keep this list in step with the console workflow contract + `missingRequiredFields`.
 */

export interface SetupFieldOption {
  value: string;
  label: string;
}

export interface SetupField {
  /** Wire field name — the console PATCH key (snake_case). */
  key: string;
  /** The question to put to a human. */
  question: string;
  /** Extra guidance / why it matters. */
  help?: string;
  /** Closed set of choices, when applicable. */
  options?: SetupFieldOption[];
  /** A concrete example value. */
  example?: string;
  /** Whether the workflow cannot go active without it (mirrors the DB CHECK). */
  requiredToPublish: boolean;
}

/**
 * The full field guide, in interview order: the required-to-publish fields first,
 * then the optional refinements (media, branched actions, cadence, targeting).
 */
export const SETUP_FIELDS: readonly SetupField[] = [
  {
    key: 'event_name',
    question: 'Which app event should trigger this ask?',
    help: 'A stable name you fire with Signal.track(...). One active workflow per event.',
    example: 'checkout_completed',
    requiredToPublish: true,
  },
  {
    key: 'metric_type',
    question: 'Are you measuring satisfaction (CSAT) or effort (CES)?',
    options: [
      { value: 'CSAT', label: 'CSAT — how satisfied were you' },
      { value: 'CES', label: 'CES — how easy was it' },
    ],
    requiredToPublish: true,
  },
  {
    key: 'rating_type',
    question: 'How should people rate — stars, emoji faces, or an effort scale?',
    options: [
      { value: 'star', label: 'Stars (1–5)' },
      { value: 'emoji', label: 'Emoji faces (1–3)' },
      { value: 'effort_scale', label: 'Effort scale (1–5)' },
    ],
    help: 'Star ⇒ scale 1–5, emoji ⇒ 1–3, effort_scale ⇒ 1–5.',
    requiredToPublish: true,
  },
  {
    key: 'rating_scale_max',
    question: 'How many points on the rating scale?',
    help: 'Usually derived from the rating type (star 5, emoji 3, effort 5).',
    requiredToPublish: true,
  },
  {
    key: 'header_text',
    question: 'What should the prompt say?',
    example: 'How was placing this order?',
    requiredToPublish: true,
  },
  {
    key: 'positive_threshold',
    question: 'At or above which rating counts as a happy (positive) response?',
    help: 'Ratings >= this take the positive branch; below it take the negative branch.',
    example: '4',
    requiredToPublish: true,
  },
  {
    key: 'other_allows_image',
    question: 'Let unhappy users attach a screenshot or photo?',
    options: [
      { value: 'true', label: 'Yes — allow a photo' },
      { value: 'false', label: 'No' },
    ],
    requiredToPublish: false,
  },
  {
    key: 'other_requires_text',
    question: 'Require a written comment on the unhappy path?',
    options: [
      { value: 'true', label: 'Yes — comment required' },
      { value: 'false', label: 'No — optional' },
    ],
    requiredToPublish: false,
  },
  {
    key: 'positive_action',
    question: 'When someone is happy, what happens after they submit?',
    options: [
      { value: 'none', label: 'Nothing — just close' },
      { value: 'thanks', label: 'Show a thank-you message' },
      { value: 'redirect', label: 'Send them to an https:// URL' },
      { value: 'store_review', label: 'Ask for an app-store review' },
    ],
    help: 'redirect needs an https url; thanks can carry a custom message.',
    requiredToPublish: false,
  },
  {
    key: 'negative_action',
    question: 'When someone is unhappy, what happens after they submit?',
    options: [
      { value: 'none', label: 'Nothing — just close' },
      { value: 'thanks', label: 'Show a thank-you message' },
      { value: 'redirect', label: 'Send them to an https:// URL (e.g. support)' },
      { value: 'store_review', label: 'Ask for an app-store review' },
    ],
    requiredToPublish: false,
  },
  {
    key: 'ask_frequency',
    question: 'If someone ignores it, how long before asking again?',
    options: [
      { value: 'after_7_days', label: 'After 7 days' },
      { value: 'after_30_days', label: 'After 30 days' },
      { value: 'after_60_days', label: 'After 60 days' },
    ],
    help: 'Applies only to a dismiss. Once someone RESPONDS they are never asked again.',
    requiredToPublish: false,
  },
  {
    key: 'sampling_rate',
    question: 'What fraction of eligible users should see it (0–1)?',
    help: '1 = everyone; 0.5 = half. Applied after every other gate.',
    example: '1',
    requiredToPublish: false,
  },
  {
    key: 'min_session_age_days',
    question: 'Minimum account age (days) before asking? Leave blank for no gate.',
    requiredToPublish: false,
  },
] as const;

/** Index for O(1) lookup by wire key. */
const FIELD_BY_KEY: ReadonlyMap<string, SetupField> = new Map(SETUP_FIELDS.map((f) => [f.key, f]));

/** One human question the agent/UI can put for a missing field. */
export interface SetupQuestion {
  field: string;
  question: string;
  options?: SetupFieldOption[];
  example?: string;
}

/**
 * Turn a `missing: string[]` (from an `incomplete` publish) into human questions,
 * preserving the canonical interview order. Unknown keys fall back to a generic ask.
 */
export function questionsFor(missing: readonly string[]): SetupQuestion[] {
  const want = new Set(missing);
  const out: SetupQuestion[] = [];
  for (const f of SETUP_FIELDS) {
    if (!want.has(f.key)) continue;
    out.push({
      field: f.key,
      question: f.question,
      ...(f.options ? { options: f.options } : {}),
      ...(f.example ? { example: f.example } : {}),
    });
  }
  // Any missing key not in the guide (shouldn't happen) still gets asked.
  for (const key of missing) {
    if (!FIELD_BY_KEY.has(key)) out.push({ field: key, question: `What should "${key}" be?` });
  }
  return out;
}

/**
 * Render the field guide as a ready-to-use interview script for an AI agent (the
 * MCP `setup_workflow` prompt). Deterministic plain text — no host state.
 */
export function setupGuideText(): string {
  const line = (f: SetupField): string => {
    const req = f.requiredToPublish ? ' (required)' : ' (optional)';
    const opts = f.options ? `  [${f.options.map((o) => o.value).join(' | ')}]` : '';
    const help = f.help ? `\n     ${f.help}` : '';
    return `- ${f.key}${req}: ${f.question}${opts}${help}`;
  };
  return [
    'Interview the user to set up a Signal CSAT/CES workflow, then create it via the',
    'workflow tools (create_workflow → publish_workflow). Ask only for what you still',
    'need; infer sensible defaults (star ⇒ scale 5, emoji ⇒ 3) and confirm. Required',
    'fields must all be set before publishing.',
    '',
    'Fields:',
    ...SETUP_FIELDS.map(line),
    '',
    'Post-submit actions are { type, message?, url? }: none | thanks (message?) |',
    'redirect (https url required) | store_review. positive_action fires on a rating',
    '>= positive_threshold, negative_action below it.',
    '',
    'Behaviour to explain to the user: if someone ignores the ask it returns after the',
    'ask_frequency window; once they respond they are never asked again (until you',
    'publish a new workflow). Each user is tracked independently.',
    '',
    'After publishing, wire the code (you are a coding agent — do this yourself):',
    '1. Run `npx @ashish221/signal-cli init` in the project. It installs the Web SDK',
    '   and adds Signal.init(...) with the account publishable key auto-fetched.',
    '2. Add `Signal.track("<event_name>")` at the moment the event happens (the same',
    '   event_name you gave create_workflow, e.g. after checkout completes).',
    'Then tell the user to trigger that event once to see the feedback ask appear, and',
    'that responses will show in their Signal dashboard.',
    '',
    'HARD BOUNDARIES — never cross these:',
    '- The Signal SDK is a PUBLISHED npm package. Only ever `npm install',
    '  @ashish221/signal-web` (the registry version). NEVER build, clone, link, copy,',
    '  vendor, or edit the Signal SDK/source, and never drop a local/hand-built bundle',
    '  into the project — an un-lockfiled build breaks on deploy and is not allowed.',
    '- If the published SDK looks stale or seems to be missing a feature, STOP and tell',
    '  the user it needs a Signal-side release (a new npm version). Do NOT patch, rebuild,',
    '  or work around it locally.',
    '- Only ever edit the USER’S OWN app code (their Signal.init / Signal.track calls).',
    '  Nothing inside Signal itself.',
  ].join('\n');
}
