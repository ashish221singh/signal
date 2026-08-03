# Signal → Generic, Agent-First Feedback Product — Design (v1, lean)

> **Status:** Design approved 2026-08-03, **descoped 2026-08-03** to a lean,
> agent-first v1 (no enterprise multi-tenancy; dashboard is reporting-only).
> Traces back to `signal-spec-v1.md` for the core loop (eligibility → sheet →
> response → suppression), which is kept almost verbatim.

## Goal

Turn Signal from a single-tenant BeatRoute tool into a **generic, agent-first
feedback product**. A developer **onboards, sets up feedback workflows from the
terminal via an agent (Claude Code / MCP), and watches the results on a reporting
dashboard.** That's the whole v1. No teams, no billing, no enterprise isolation —
those are deferred until there's demand.

## What "lean" means here

We are **not** building a hardened multi-tenant SaaS yet. Multiple people can onboard
and each sees only their own data — but that's achieved with a simple **Account**
model and a plain `account_id` filter, **not** RLS, per-tenant rate limiting,
replicas, Redis, partitioning, or billing. Those move to a "later, if it grows"
list (see § Deferred).

## Locked decisions

1. **Lightweight accounts** — one signup = one owner = one Account. A single `account_id` FK on domain tables, filtered in the existing repository layer. No workspaces/teams, no RLS, no enterprise isolation.
2. **Agent-first setup** — the primary way to build a workflow is from the terminal: `npx @signal/cli` + an MCP server the user's own agent (Claude Code / Cursor) drives. It creates the workflow *and* wires the `track()` call into the user's code.
3. **Dashboard = reporting only** — the web dashboard shows output (responses, metrics, trend). Minimal workflow-building UI; setup lives in the terminal.
4. **All surfaces, one sheet** — web-core bottom sheet built once; native SDKs (Android/iOS/RN) are thin WebView shells; hosted link for free.
5. **Anonymous / user-id only** — no traits or segments; targeting is by event + rules.
6. **Named events via SDK** — `signal.track("event")`; one active workflow per `(account_id, event_name)`.

---

## Section 1 — Account model & data

**Account is the unit.** Signup (email + password, or CLI device-flow) creates one
Account with one owner. Every domain row gets an `account_id`; every query filters on
it via the existing repository layer — a normal `WHERE account_id = ?`, nothing more.

**Keys.** Per-account API keys:
- **publishable key** — ships in the SDK; backend derives the account from it, so the SDK never sends an `account_id`.
- **CLI token** — short-lived, revocable; minted by device-flow login; used by CLI/MCP to create/publish workflows. (Scoped so an agent holding it can't do more than manage workflows.)

**Removed (BeatRoute-specific):** the `clients` table, `campaign.client_ids`, the
entire `sync/` module (BeatRoute OAuth pull + `sync-clients` CLI + `beatrouteClient`),
and the M4 per-client reporting endpoint.

**Renamed / kept:** `campaign` → **workflow**; `target`/screen → optional response
metadata; `trigger_log`, `response`, suppression logic — kept, re-keyed on
`(account_id, event_name, user_id)`. Uniqueness: **one active workflow per
`(account_id, event_name)`**, oldest-wins, enforced at publish.

---

## Section 2 — Trigger & eligibility model (reused core loop)

**The event is the spine.** A workflow declares one `event_name`. The SDK calls
`signal.track("checkout_completed", { userId })`. The M1 hot path is reused, re-keyed:

1. SDK → `POST /v1/sdk/eligibility` (publishable key, `event_name`, `user_id`, optional generic `session_age_days`).
2. Backend resolves key → account, finds the active workflow for `(account, event)`, runs the **existing** `decide.ts`: cooldown (`after_7/30/60_days`), **sampling %** (new per-workflow field), daily cap, atomic suppression claim.
3. Returns "not eligible" (silent) or the workflow config (sheet type, copy, chips, rating style).
4. Answer/dismiss → `/response` `/dismiss`, keyed on server-issued `trigger_id`, idempotent, into the outbox. Unchanged.

**Reused unchanged:** `decide.ts`, cooldown math, atomic claim, `trigger_id`
idempotency, outbox contract. **Deltas:** drop `client_id`; key on `event_name`; add
per-workflow sampling rate.

---

## Section 3 — SDK architecture (web-core + native shells)

**One renderer, many hosts.** The bottom sheet is built once as a framework-agnostic
**web-core** TS bundle (rating widget, positive/negative/"other" branches, chips,
text, image attach + client state machine). The only place sheet UI lives.

- **Web SDK (`@signal/web`)** — web-core in an iframe / shadow-DOM (style isolation), `localStorage` suppression + `sendBeacon` outbox. Flagship for self-serve; also the first target the agent wires up.
- **Android SDK** — reuse `EligibilityClient`, `FeedbackClient`, Room+WorkManager outbox, `LocalSuppressionCache`, `DwellTimer`, trackEvent hooks; replace the native View sheet with a **WebView** hosting web-core. ~60% survives.
- **iOS SDK** — new, small: `WKWebView` + Swift ports of eligibility client, outbox, suppression.
- **React Native** — thinnest: JS wrapper reusing `@signal/web` in an RN WebView + trigger bridge.
- **Hosted link** — web-core served standalone. Zero SDK. Free.

**Contract:** web-core ↔ native shell talk over a small JS bridge (`ready`, `submit`,
`dismiss`, `resize`). Native owns networking + persistence (offline-safe); web-core
owns pixels. **web-core is bundled inside** each native SDK (no cold-fetch); the
config↔renderer contract is versioned for backward compatibility.

---

## Section 4 — Agent-first setup (the primary surface)

The backend is already **API-first** (every M2/M4 action is an authenticated endpoint).
The agentic layer is a thin wrapper — and in this lean v1 it is *the* way users set up.

**CLI (`npx @signal/cli`):** `init` (device-flow auth → writes CLI token +
publishable key locally, installs the surface-appropriate SDK, adds the one-line
`Signal.init`), `login`, `whoami`, `deploy`.

**MCP server:** exposes the API as tools — `create_workflow`, `list_events`,
`link_trigger`, `set_rules`, `publish`, `get_responses`. Any MCP agent (Claude Code,
Cursor) drives Signal conversationally. No bundled LLM, no inference cost to us — the
*user's* agent supplies the intelligence; we ship tools.

**Config-as-code (optional, same deploy path):** workflows may live in the repo as
`signal.config.ts`; `signal deploy` idempotently upserts through the **same** service
MCP writes through (design that upsert once). A `managed_by: code | console` flag keeps
the two write paths from clobbering each other.

### The agent setup loop

Developer in Claude Code: *"Add a CSAT survey after checkout, once every 30 days."*
1. **One-time**: agent runs `npx @signal/cli init` — auths the account, installs the SDK, adds `Signal.init(publishableKey)`.
2. **Wire the trigger**: agent reads the repo, finds the checkout-success handler, inserts `signal.track("checkout_completed", { userId })` as a reviewable diff (user approves — never a silent edit).
3. **Create the workflow**: agent calls MCP `create_workflow` (or writes `signal.config.ts` + `deploy`).
4. **Verify**: web-core renders the sheet at a hosted preview link instantly.

**Describe the moment → agent wires code + creates workflow → live in one flow.**

---

## Section 5 — Reporting dashboard (the only web UI in v1)

A **minimal** web app. Its job is to show output, not to build workflows.
- **Onboarding**: sign up, see the `npx @signal/cli` command + publishable key, done.
- **Reporting** (reuses built M2/M4 endpoints, filtered by `account_id`): Overview (counts, response rate, positive score), Reasons (ranked chips), Responses feed (filter to low scores, read comments, view images), 30-day Trend.
- **Read-only on workflows**: list what exists + status; editing happens in the terminal/config. (A light "pause/archive" button is fine; full building is not a v1 UI goal.)
- **Removed** from the old prototype: the Clients page and all BeatRoute client-sync UI.

---

## Deferred (build only if/when it grows)

Everything that made the earlier design heavy — parked, not forgotten:
- **Teams / workspaces / memberships**, workspace switching.
- **Hardened isolation**: Postgres RLS, structural scoped-repo enforcement (v1 relies on the plain `account_id` filter + tests).
- **Scale infra**: read replicas, Redis cache + pub/sub invalidation, `trigger_log` partitioning + retention, per-tenant rate limiting. (Keep a *basic* global rate limit on the public ingest path — cheap abuse protection — but nothing per-tenant.)
- **Billing / metering.**
- **Standalone NL CLI** (agent embedded in our binary) — users point their *own* agent at our MCP server instead.
- **Traits / segments** targeting.

One thing to keep even in lean mode: **the publishable key is public**, so put a
simple global rate limit + web-origin allow-list on `/eligibility` and `/response`,
and treat that data as client-side/untrusted. Cheap, and saves pain later.

---

## Reuse / remove / net-new scorecard

| Area | Verdict |
|---|---|
| Backend hot path (`decide.ts`, claim, cooldown, `trigger_id` idempotency, outbox) | **~100% kept**, re-keyed on event |
| Console API (auth, workflow CRUD, publish, reporting) | **kept**, minus client endpoints; add accounts + keys |
| Android SDK networking/outbox/suppression/triggers | **~60% kept** |
| Android native View sheet | **retired** for WebView + web-core |
| `clients` table, `client_ids`, `sync/` module, per-client reporting | **removed** |
| Web-core renderer, `@signal/web`, iOS SDK, RN wrapper, hosted link | **net-new** |
| Accounts, per-account API keys, CLI tokens | **net-new** (lightweight) |
| CLI, MCP server, config-as-code deploy path | **net-new** (thin, over finished API) |
| RLS, replicas, Redis, partitioning, billing, teams | **deferred** |

---

## Proposed build sequence (milestones M5+)

- **M5 — Accounts + event workflows (backend).** Add `Account`, `account_id` on every table, signup + per-account publishable key + CLI token, re-key eligibility on `event_name`, remove `clients`/`sync`. Basic global rate limit + origin allow-list on public ingest. *(Foundation; reuses the proven core loop.)*
- **M6 — Web-core + Web SDK + hosted link.** Build the one renderer; ship `@signal/web`; hosted preview. The thing the agent wires up.
- **M7 — Agent-first setup.** CLI (`init`/`login`/`deploy`), MCP server, config-as-code shared upsert path, `managed_by` flag, CLI-token auth. **The differentiator and the primary setup surface.**
- **M8 — Reporting dashboard.** Minimal React app: signup/onboarding + reporting views on the M2/M4 endpoints (account-scoped). The "see output" half of v1.
- **M9 — Native shells (later).** Android refit to WebView + web-core; iOS SDK; RN wrapper. Expansion beyond web.

## Open decisions (before build)

- **D-1 Hosting/deploy target** — any simple host + one Postgres now suffices (replicas/Redis deferred). Still the one thing blocking go-live. Recommendation: Railway or Fly.io (managed Postgres, easy).
- **D-2 Signup surface** — web page vs CLI-only device flow vs both (agent-first leans CLI, but a web signup is friendlier for the first touch).
- **D-3 Event-name governance** — free-form ingest vs a registered list. Recommendation: free-form, auto-surfaced in the dashboard's Events view so typos become visible instead of silent.
- **D-4 web-core distribution** — bundled in native SDKs (yes) + versioned CDN w/ SRI for the web SDK.
