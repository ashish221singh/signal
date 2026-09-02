# Signal CLI, MCP & Config-as-Code (B3)

The agentic surface makes everything a PM/dev can do reachable from the terminal and
from an AI agent. It sits on the finished B1/B2 console API — the CLI and MCP server
are HTTP clients that authenticate with a **CLI token** and hit the same
`/v1/console/*` endpoints humans do, so they inherit all validation and account
isolation.

## Auth model

A request to `/v1/console/*` carries **either**:

- a console **cookie session** (from the server-rendered `/login`) ⇒ all scopes, or
- an `Authorization: Bearer cli_…` **CLI token** ⇒ the token's scopes.

Scopes: `workflows:read`, `workflows:write`, `responses:read`, `deploy`. Each route
asserts the scope it needs (a read-only token gets `403 insufficient_scope` on a
write).

### Getting a token

**Device flow (recommended, the only prod path):**

```
signal login
```

Prints a URL + short code; open the URL in a browser, log in, and approve. The CLI
polls and saves the token to `~/.signal/config.json`.

**Interim password login (dev/CI only — off in production):**

```
signal login --password --email you@example.com --password-value 'secret'
```

Gated by `ALLOW_PASSWORD_CLI_LOGIN` (default ON in dev/test, OFF in production).

You can also mint/list/revoke tokens from the console API:
`POST/GET/DELETE /v1/console/cli-tokens` and keys via `/v1/console/keys`.

### Server-rendered auth pages

Before the React dashboard exists, the API serves plain HTML at `/signup`, `/login`,
and `/cli/approve` (the device-approval page). These are the always-available auth
fallback; the dashboard later supersedes them for reporting.

## CLI (`@signal/cli`)

```
signal login                 # device flow
signal login --password …    # interim credential login
signal whoami                # show the stored login
signal setup                 # interactive wizard: interview → create → publish a workflow
signal deploy <file>         # apply a config-as-code file
signal workflows list        # list the account's workflows
signal init <pk_…> [--dir d] # install the Web SDK + wire Signal.init (F2-D8)
```

Config lives in `~/.signal/config.json` (`SIGNAL_CONFIG_DIR` overrides the dir;
`--api-url` / `SIGNAL_API_URL` overrides the API base URL).

### `signal init` — Web SDK install (F2-D8)

One-time setup for a web/npm project. It (idempotently) adds `@signal/web` to the
project's `package.json` dependencies and writes a `signal-setup.js` snippet that
calls `Signal.init('<publishableKey>')`, then prints next steps (install + import
the snippet, then `Signal.track('event')`). It never rewrites your own entry/source
files (guessing wrong is worse than a one-line manual step); an unknown project
(no `package.json`) prints manual steps instead of guessing. Native SDK install is
out of scope. Does not require login (offline, no API call).

## Guided setup (agent-guided setup)

Creating a workflow is an interview, not a form — and it works three ways off one
shared field guide (`@signal/contracts` `SETUP_FIELDS`):

- **AI agent (MCP).** The `setup_workflow` **prompt** hands the agent a ready interview
  script (every field, its options, and the never-reask/cooldown behaviour). The agent
  asks the user, then calls `create_workflow` → `publish_workflow`.
- **Self-correction.** If `publish_workflow` (or the API's `POST /workflows/:id/publish`)
  is called incomplete, it returns `422 { error.code: 'incomplete', missing: [...],
  questions: [{ field, question, options? }] }` — a machine-readable list of exactly what
  to ask, phrased for a human. The agent fills them via `update_workflow` and re-publishes.
- **No agent? `signal setup`.** An interactive terminal wizard walks the same questions
  (stars vs emoji, media, thresholds, thank-you vs redirect, cadence) and publishes for you.

Behaviour worth stating to users: once someone **responds** they're never asked again;
if they **ignore** it, it returns after the `ask_frequency` window (7/30/60 days). Each
end-user is tracked independently.

## Config-as-code deploy

`signal deploy <file>` posts to `POST /v1/console/deploy` (scope `deploy`). The file
is `signal.config.{ts,js,json}` whose default export is `{ workflows: [...] }`. Each
item has a stable **`key`** (its identity) plus the workflow builder fields:

```ts
// signal.config.ts
export default {
  workflows: [
    {
      key: 'checkout-csat',
      event_name: 'checkout_completed',
      status: 'active', // draft | active | paused (default: active)
      metric_type: 'CSAT',
      rating_type: 'star',
      rating_scale_max: 5,
      header_text: 'How was your checkout?',
      positive_threshold: 4,
      chips_on_negative: ['Slow', 'Confusing'],
      sampling_rate: 1,
      // Branched post-submit actions (B5). `onPositive` fires when the rating is
      // >= positive_threshold, `onNegative` otherwise. Each is one of:
      //   { type: 'none' }
      //   { type: 'thanks', message?: string }      // default message if omitted
      //   { type: 'redirect', url: 'https://…' }    // https-only, required
      //   { type: 'store_review' }                  // ask for an app-store review
      onPositive: { type: 'store_review' },
      onNegative: { type: 'redirect', url: 'https://support.acme.com/checkout' },
    },
  ],
};
```

**Post-submit actions (B5), natural language → config.** The agent maps intent to
`onPositive`/`onNegative`:

- _"Thank happy raters and send unhappy ones to our support page"_ →
  `onPositive: { type: 'thanks' }`, `onNegative: { type: 'redirect', url: 'https://…' }`
- _"Ask 5-star folks to review us on the store; just close for everyone else"_ →
  `onPositive: { type: 'store_review' }`, `onNegative: { type: 'none' }`

A `redirect` **requires** a valid `https://` url (an `http://`, `javascript:`, or
missing url is rejected `422` with a message the agent can self-correct from). A blank
`thanks` message gets a sensible default. `store_review` degrades to a thank-you/close
on surfaces with no store (e.g. web).

Semantics:

- **Idempotent upsert by `(account, key)`** — create or update; unchanged items report
  `unchanged`. `managed_by` is set to `code`.
- **Prune** — a code-managed workflow whose `key` is absent from the payload is
  **archived** (never hard-deleted).
- **Lock** — console/MCP edits to a code-managed workflow are rejected `409
  code_managed`; edit the config and re-`deploy` instead.
- **Event-uniqueness (partial success)** — an item whose `event_name` already has a
  different active workflow fails with `event_conflict` naming the incumbent; the rest
  of the deploy still applies. The response lists a result per item.

> A `.ts` config needs a TypeScript-aware runtime — run the CLI via `tsx`. `.json`
> and `.js`/`.mjs` work with plain Node.

## MCP server (`@signal/mcp`)

A stdio MCP server exposing the console API as tools. HTTP-only (no DB). Run via:

```
SIGNAL_API_URL=http://localhost:3000 SIGNAL_TOKEN=cli_… npx @signal/mcp
```

Tools: `list_workflows`, `get_workflow`, `create_workflow`, `update_workflow`,
`set_rules`, `publish_workflow`, `pause_workflow`, `list_events`, `get_overview`,
`get_responses`. Each maps to console API calls; API errors surface as `isError`
results carrying the server's `{ code, message }` (e.g. `code_managed`,
`event_conflict`).

`create_workflow`/`update_workflow` accept the branched post-submit actions in the
same plain terms as the deploy config — `onPositive` and `onNegative`, each an
`{ type, message?, url? }` action (see the deploy section above).

The server also exposes a **prompt**, `setup_workflow` — the interview script an agent
pulls before creating a workflow (see *Guided setup* above).

## Event surfacing

The eligibility hot path keeps an in-memory per-account seen-set; on the first
sighting of an `event_name` this process hasn't recorded, it fires a best-effort async
upsert into `seen_events`. Steady state adds **no** per-call DB write.
`GET /v1/console/events` (also the MCP `list_events` tool) lists the surfaced events so
a PM can discover which events the app fires and target them.

## Environment

| var | default | notes |
|-----|---------|-------|
| `PUBLIC_BASE_URL` | `http://localhost:3000` | base for the device-flow `verification_uri`; set to the real host before first deploy |
| `ALLOW_PASSWORD_CLI_LOGIN` | on in dev/test, off in prod | interim password→token login gate |
| `SIGNAL_API_URL` | `http://localhost:3000` | CLI/MCP API base URL |
| `SIGNAL_TOKEN` | — | CLI token for the MCP server |
| `SIGNAL_CONFIG_DIR` | `~/.signal` | CLI credential directory |
