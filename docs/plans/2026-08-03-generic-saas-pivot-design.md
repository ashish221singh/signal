# Signal → Generic, Agent-Native Feedback SaaS — Design (v1)

> **Status:** Design approved 2026-08-03 (brainstorming session). Supersedes the
> BeatRoute-specific framing of `signal-spec-v1.md` where the two conflict.
> Traces back to that spec for the core loop (eligibility → sheet → response →
> suppression), which is kept almost verbatim.

## Goal

Turn Signal from a single-tenant internal tool for BeatRoute into a **self-serve,
multi-tenant SaaS** that anyone can sign up for, build feedback **workflows** in,
and integrate on **any surface** (web, Android, iOS, React Native) — with an
**agent-native** setup path: a developer in Claude Code / any MCP agent can create
a workflow *and* wire the trigger into their own code from the terminal, in one flow.

## Locked decisions

1. **Self-serve SaaS** — public signup, multi-tenant, hard data isolation.
2. **All surfaces** — one bottom-sheet design running on web, Android, iOS, RN, plus a hosted link.
3. **Web-core + native shells** — the sheet is built once as HTML/JS; native SDKs are thin WebView wrappers with native triggers + offline outbox.
4. **Anonymous / user-id only** — no traits or segments in v1; targeting is by event + rules.
5. **Named events via SDK** — `signal.track("event")`; the console/config links an event to one workflow.
6. **Agentic surface = MCP server + thin CLI (Layer A) + config-as-code (Layer B)** over one shared idempotent deploy path. Standalone NL CLI (Layer C) deferred.

---

## Section 1 — Multi-tenancy & data model

**Workspace is the new top-level tenant.** Every domain row gains a `workspace_id`;
every query is filtered by it — the hard isolation boundary. A `console_user` relates
to a workspace through a `membership` join (one person can later hold multiple
workspaces). **Signup** creates a workspace + first admin in one transaction.

**Keys.** The single global app-key becomes **per-workspace API keys**:
- **publishable key** — safe to ship in the SDK; used for `/eligibility` + `/response`. The backend derives the tenant from the key, so the SDK never sends a `workspace_id`.
- **secret key** — server-side use (later).
- **CLI token** — short-lived, scoped, revocable; minted by device-flow login; used by the CLI/MCP for create/publish (see §4, §6).

**Removed (BeatRoute-specific):** the `clients` table, `campaign.client_ids`, the
entire `sync/` module (BeatRoute OAuth client-list pull, `sync-clients` CLI,
`beatrouteClient`), and the M4 per-client reporting endpoint.

**Renamed / kept:** `campaign` → **workflow** (same table, new semantics);
`target`/screen → optional free-text metadata on a response (not a targeting axis);
`trigger_log`, `response`, suppression logic — kept, re-keyed on
`(workspace_id, event_name, user_id)`.

**Uniqueness rule:** "one active campaign per (target, client)" becomes
**"one active workflow per (workspace_id, event_name)"** — same oldest-wins tie-break,
enforced at publish by service validation + a DB constraint.

---

## Section 2 — Trigger & eligibility model

**The event is the spine.** A workflow declares one `event_name`. At runtime the SDK
calls `signal.track("checkout_completed", { userId })`. The backend hot path is the
M1 path, re-keyed:

1. SDK → `POST /v1/sdk/eligibility` (publishable key, `event_name`, `user_id`, optional generic `session_age_days`).
2. Backend resolves key → workspace, finds the one active workflow for `(workspace, event)`, runs the **existing** `decide.ts`: cooldown (`after_7/30/60_days`), **sampling %** (new per-workflow field), daily cap, atomic suppression claim.
3. Returns "not eligible" (silent) or the **workflow config** (sheet type, copy, chips, rating style) — same config contract the SDK already renders.
4. Answer/dismiss → `/response` `/dismiss`, keyed on server-issued `trigger_id`, idempotent, into the outbox. Unchanged.

**Deltas vs today:** drop `client_id` everywhere; `event_name` replaces the
`(target, client)` lookup; add per-workflow **sampling rate**.
**Reused unchanged:** `decide.ts`, cooldown math, atomic claim, `trigger_id`
idempotency, outbox contract.

---

## Section 3 — SDK architecture (web-core + native shells)

**One renderer, many hosts.** The bottom sheet is built once as a framework-agnostic
**web-core** TS bundle: takes workflow-config JSON, renders the full sheet (rating
widget star/emoji/effort, positive/negative/"other" branches, chips, text, image
attach) + the client state machine. The only place sheet UI lives.

**Each surface is a thin shell:**
- **Web SDK (`@signal/web`)** — loads web-core in an iframe / shadow-DOM (style isolation), `localStorage` suppression cache + `sendBeacon` outbox. Flagship for self-serve.
- **Android SDK** — keeps `EligibilityClient`, `FeedbackClient`, Room+WorkManager **outbox**, `LocalSuppressionCache`, `DwellTimer`, trackEvent hooks. Replaces the native View sheet (`SignalBottomSheetFragment`, `RatingView`, XML layouts) with a **WebView** hosting web-core. ~60% survives.
- **iOS SDK** — new, small: `WKWebView` + Swift ports of eligibility client, outbox, suppression. Mirrors Android.
- **React Native** — thinnest: JS wrapper reusing `@signal/web`'s renderer in an RN WebView + a native-trigger bridge.
- **Hosted link** — web-core served standalone. Zero SDK. Free.

**The contract:** web-core ↔ native shell talk over a tiny **JS bridge**
(`ready`, `submit`, `dismiss`, `resize`). Native owns networking + persistence
(offline-safe); web-core owns pixels + interaction. One design change → edit web-core
→ every surface updates.

**Bundling:** web-core is **bundled inside** each native SDK (not fetched per show);
WebView pre-warmed on `init`; config↔renderer contract is **versioned** for
backward compatibility.

---

## Section 4 — Agentic layer (CLI + MCP + config-as-code)

The backend is already **API-first** (every M2/M4 action is an authenticated endpoint,
"proven over curl, no UI"). The agentic layer is a thin wrapper on that surface.

**Layer A — MCP server + thin CLI.**
- **CLI** (`npx @signal/cli`): `init` (device-flow auth → writes CLI token + publishable key to local config, installs the right SDK for the detected project, adds the one-line `Signal.init`), `deploy`, `login`, `whoami`.
- **MCP server**: exposes the API as tools — `create_workflow`, `list_events`, `link_trigger`, `set_rules`, `publish`, `get_responses`. Any MCP agent (Claude Code, Cursor) drives Signal conversationally. No bundled LLM, no inference cost to us — the *user's* agent supplies intelligence; we ship tools.

**Layer B — config-as-code.** Workflows may also live in the customer repo:
```ts
export default defineWorkflows([
  { key: "post-checkout-csat", event: "checkout_completed", type: "csat",
    rules: { cooldown: "after_30_days", sample: 0.5 } },
])
```
`signal deploy` idempotently upserts into the workspace. **Shared deploy path:** MCP
and `deploy` write through the *same* upsert service (design it once). Benefits: git
source-of-truth, PR review, CI/CD sync, and a safer agent path (agent edits a file;
nothing changes until `deploy`).

**Layer C — standalone NL CLI (deferred).** A `signal "add a survey after checkout"`
binary with its *own* embedded agent. Deferred because anyone can already point their
own agent at our MCP server for the same result at zero inference cost to us.

### The agent setup flow (the magic loop)

Developer in Claude Code types: *"Add a CSAT survey after checkout, once every 30 days."*
1. **One-time setup** (first run): agent runs `npx @signal/cli init` — auths the workspace, installs the surface-appropriate SDK, adds `Signal.init(publishableKey)`.
2. **Find the trigger site**: agent reads the repo, locates the checkout-success handler, and **inserts** `signal.track("checkout_completed", { userId })` as a reviewable diff (user approves — never a silent edit to payment code).
3. **Create the workflow**: agent calls MCP `create_workflow` (or writes `signal.config.ts` + `deploy`) — event `checkout_completed`, CSAT, `after_30_days`, published.
4. **Instantly testable**: web-core means the workflow renders at a hosted preview link before redeploy.

Result: **describe the moment → agent wires code + creates workflow → live in one flow.**

---

## Section 5 — Console changes

The console is the last thing built (UI is still a prototype). Changes vs the
BeatRoute prototype:
- **New:** signup + workspace creation, workspace switcher, **API keys page**, **Events** view (which event names have been seen), **CLI/SDK install** page (copy-paste snippet + `npx` command), config-as-code status ("managed by code" badge).
- **Removed:** the **Clients** page/section and the BeatRoute client-sync UI entirely.
- **Reframed:** "Campaigns" → **Workflows**; the builder's targeting step changes from *(screen + client)* to *(event name + rules: cooldown, sampling, daily cap)*; "Screens/Targets" demoted to optional response metadata.
- **Reporting:** Overview, Reasons, Responses feed, Trend — kept; **per-client breakdown removed**; all reads move to a replica / rollups (§ Scalability).

---

## Scalability & hardening (folded-in gap fixes)

These are structural — cheap now, expensive late. Items 1–3, 7, 8 are baked into the
design; 4–6 are "design the seam, build when traffic demands."

**Critical — in the design now:**
1. **Publishable key is public → untrusted ingest.** Per-key + per-`user_id` rate limits on `/eligibility` and `/response`; per-workspace web-origin allow-list (CORS + referer); documented "client-side numbers" trust boundary. (Today rate-limiting exists only on console login.)
2. **Tenant isolation defense-in-depth.** Postgres **Row-Level Security** as a backstop *and* a repository layer that structurally injects `workspace_id` (no raw queries at call sites); a test that fails if any table is queried unscoped.
3. **Hot-path/reporting split + `trigger_log` growth.** Read replica for all reporting/console reads (M4 aggregations must not contend with the write hot path); `trigger_log` **time-partitioned + retention** from day one; lean on `LocalSuppressionCache` to short-circuit ineligible calls before they hit the DB.

**Scale — design the seam, build later:**
4. **Campaign cache doesn't survive multi-tenancy.** Replace the global 60s full-load (`campaigns/cache.ts`) with a per-workspace lazy cache (TTL) or shared Redis with pub/sub invalidation on publish — fixes both the growing scan and cross-instance publish staleness.
5. **Reporting pre-aggregation.** Daily rollup tables / materialized views per workflow; the 30-day trend reads rollups, not raw rows.
6. **WebView cold-start.** Bundle web-core in the native SDK; pre-warm the WebView on `init`; version the config↔renderer contract.

**Agentic safety — in the design now:**
7. **Dual-write drift (MCP live vs config deploy).** A `managed_by: code | console` flag per workflow; config-owned workflows reject console/MCP edits (or warn). `deploy` prune semantics reuse "deactivate, never delete."
8. **Agent credential scoping.** Short-lived, scoped, revocable **CLI tokens** (create/publish scope) minted by device-flow login — never the secret key pasted into an agent; revocable from the console.

**Watch-list (note, don't act yet):**
- **PII / GDPR** — free-text + images are cross-tenant end-user PII; need `user_id`-keyed deletion (right-to-be-forgotten) and per-workspace export. Cheap if `user_id` is indexed everywhere now.
- **Presign scoping** — `uploads/presign.ts` must scope the S3 key by `workspace_id`; no cross-tenant object access.
- **Hosting/deploy** — still undefined; the one thing blocking go-live.

---

## Reuse / remove / net-new scorecard

| Area | Verdict |
|---|---|
| Backend hot path (`decide.ts`, claim, cooldown, `trigger_id` idempotency, outbox contract) | **~100% kept**, re-keyed on event |
| Console API (auth, campaign/workflow CRUD, publish, reporting) | **kept**, minus client endpoints; add workspace/keys/events |
| Android SDK networking/outbox/suppression/triggers | **~60% kept** |
| Android native View sheet (`SignalBottomSheetFragment`, `RatingView`, XML) | **retired** for WebView + web-core |
| `clients` table, `client_ids`, `sync/` module, per-client reporting | **removed** |
| Web-core renderer, `@signal/web`, iOS SDK, RN wrapper, hosted link | **net-new** |
| Workspaces, memberships, API keys, CLI tokens | **net-new** |
| CLI, MCP server, config-as-code deploy path | **net-new** (thin, over finished API) |
| RLS, per-tenant rate limiting, replica/rollups, partitioning | **net-new** (hardening) |

---

## Proposed build sequence (milestones M5+)

Ordered so each milestone is shippable and de-risks the next.

- **M5 — Multi-tenancy core.** Workspaces, memberships, `workspace_id` everywhere, per-workspace API keys, signup, RLS backstop + scoped repository layer, per-tenant rate limiting. Remove `clients`/`sync`. Re-key eligibility on `event_name`. *(Backend only — the riskiest, most foundational change.)*
- **M6 — Web-core + Web SDK + hosted link.** Build the one renderer; ship `@signal/web`; hosted preview link. First surface a customer can self-integrate.
- **M7 — Agentic layer.** CLI (`init`/`deploy`), MCP server, config-as-code shared upsert path, `managed_by` flag, CLI-token auth. The differentiator.
- **M8 — Native shells.** Refit Android to WebView + web-core; new iOS SDK; RN wrapper.
- **M9 — Console UI (React SPA).** The prototype becomes real, workspace-aware, against the M5–M7 APIs. Reporting on replica/rollups.
- **M10 — Scale hardening.** `trigger_log` partitioning + retention, reporting rollups, Redis cache + pub/sub invalidation — as traffic demands.

## Open decisions (before build)

- **D-1 Hosting/deploy target** (Fly/Railway/Render/AWS) — blocks go-live and shapes replica/Redis choices.
- **D-2 Billing** — plans/metering deferred, but event volume is the natural meter; decide the metering hook early even if billing is later.
- **D-3 Event name governance** — free-form vs a registered event list per workspace (affects the Events view and typo-safety).
- **D-4 web-core distribution** — CDN + SRI for web vs bundled-only; versioning policy for the config contract.
