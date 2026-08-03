# B2 — Event Re-key (Workflows) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the BeatRoute screen+client trigger model with the generic one: a **workflow** listens for a named **event**. `signal.track("checkout_completed")` fires eligibility, keyed on `(account_id, event_name)`. Add per-workflow **sampling**, enforce **one active workflow per event per account**, and add the cheap public-ingest **hardening** (rate limit + origin allow-list). Reuses the B1 account scoping and the proven decision/claim/idempotency logic. **No UI.**

**Architecture:** Unchanged layering. `campaigns` becomes `workflows`; `target_registry` (screens) is deleted as a targeting axis — an optional free-form `context` string travels on eligibility for debugging only. The in-memory cache re-indexes by `(account_id, event_name)`. Sampling is a pure gate injected with an RNG so it stays testable. Hardening uses `@fastify/rate-limit` (already present) and a per-account `allowed_origins` list.

**Tech Stack:** unchanged. No new dependencies.

**Prerequisites:** **B1 merged** (accounts, `account_id` everywhere, publishable-key auth, no clients/sync). `pnpm verify` green.

---

## Decisions & Edge Cases (binding)

| # | Decision | Rationale / edge case |
|---|---|---|
| B2-D1 | Rename `campaigns` → **`workflows`** (fresh migration, disposable DB). Drop `target_registry`, `integration_status`, `trigger_mechanism` enums. | Screens are no longer a targeting concept; a rename keeps the reused logic intact. |
| B2-D2 | Add `event_name text` (required for active), `sampling_rate numeric(4,3) default 1.000` (0–1), `min_session_age_days int?` (renamed from `min_tenure_days`). Remove `target_id`. | The event is the trigger; sampling and session-age are the only runtime gates besides cooldown/cap. |
| B2-D3 | **One active workflow per `(account_id, event_name)`** — partial `uniqueIndex … WHERE status='active'`; runtime tie-break oldest-`created_at` wins; publish returns **409** on overlap. | Makes "find the workflow", singular, structurally true; matches M1-D3 lineage. |
| B2-D4 | **Sampling gate** runs in `decide.ts` after cooldown/cap pass, using an injected `rng()`; a **not-sampled** trigger returns not-eligible and writes **no** `trigger_log`/`suppression` row. | Sampling must not consume a user's cooldown — a skipped ask should be invisible. RNG injected for deterministic tests. |
| B2-D5 | Eligibility request: `event_name` (required), `context` (optional free string, e.g. screen name), `session_age_days` (optional; renamed from `rep_tenure_days`). Drop `screen_id`/`client_id`. Response config unchanged in shape. | Generic, minimal ingest contract. `context` is metadata only — never a targeting key. |
| B2-D6 | Cache loader selects active workflows and indexes by `(account_id, event_name)`; the 60s full-load stays (Redis deferred). | Only the lookup key changes from B1's `(account, screen)`. |
| B2-D7 | **Hardening-lite** on `/v1/sdk/*`: rate limit keyed by `publishableKey + user_id` (e.g. 60/min); per-account `allowed_origins text[]` on `api_keys` — enforced only when an `Origin` header is present (browsers); native SDKs send none and pass. | Publishable keys are public; this blunts spoofing/abuse without per-tenant infra. |
| B2-D8 | Delete `routes/console/targets.ts` + service + contracts. Workflows reference `event_name` as free text (validated shape only; event *registry* is B3). | Targets/screens are gone; the "events seen" surface arrives in B3. |
| B2-D9 | `trigger_log`/`responses` store `event_name` and optional `context`; drop `screen_id`. | Reporting groups by event; context is retained for drill-down only. |

---

## Data model (delta on B1)

```
workflows (was campaigns)
  + event_name text                 // required when status='active' (CHECK)
  + sampling_rate numeric(4,3) default 1.000
  + min_session_age_days int?       // renamed from min_tenure_days
  − target_id
  partial uniqueIndex (account_id, event_name) WHERE status='active'
  CHECK active-complete: event_name + metric + rating + scale + header + positive_threshold NOT NULL

api_keys  + allowed_origins text[] default '{}'
trigger_log  + event_name text, + context text?, − screen_id
responses    + event_name text, + context text?, − screen_id
— DROP target_registry, integration_status enum, trigger_mechanism enum
```

---

## Tasks

### Task 1 — Schema (B2-D1,D2,D3,D9)
Rename table; add `event_name`/`sampling_rate`/`min_session_age_days`; drop `target_id`/`target_registry`; add partial unique index; amend CHECK; add `event_name`/`context` to `trigger_log`/`responses`, drop `screen_id`; add `allowed_origins` to `api_keys`. Regenerate `0000` (still pre-prod, single migration). **Verify:** `schema.int.test.ts` asserts the partial unique index + CHECK.

### Task 2 — Contracts (B2-D5)
Rename campaign contracts → workflow (`event_name`, `sampling_rate`, `min_session_age_days`); rewrite eligibility request (`event_name`, `context?`, `session_age_days?`), drop `screen_id`/`client_id`; drop targets contract. **Verify:** contract unit tests.

### Task 3 — Decision logic (B2-D4)
`decide.ts`: add `samplingRate` + `minSessionAgeDays` inputs and an injected `rng`; order = cooldown → cap → session-age → **sample**; not-sampled ⇒ `{ eligible:false, reason:'not_sampled', record:false }`. **Verify:** `decide.test.ts` covers sampled/not-sampled (rng stubbed), session-age boundary.

### Task 4 — Eligibility service + cache (B2-D6,D9)
Loader/cache index by `(account_id, event_name)`; service resolves account (B1 key), looks up by event, honours `record:false` (no trigger/suppression write when not sampled), stores `event_name`/`context` on `trigger_log`. **Verify:** `eligibility.int.test.ts` — event lookup, sampling skip writes nothing, oldest-wins tie-break.

### Task 5 — Feedback (B2-D9)
`respond.ts`/`dismiss.ts` store `event_name`/`context`; drop `screen_id`. **Verify:** updated int tests.

### Task 6 — Workflows console CRUD (B2-D3)
Rename campaigns routes/service → workflows; create/update/list/get; publish validates completeness AND overlap on `(account, event_name)` → 409; pause/resume/archive/delete. `event_name` immutable after first response (extend the semantic-field lock). **Verify:** `console-workflows.int.test.ts` incl. overlap 409 + isolation (A vs B).

### Task 7 — Drop targets (B2-D8)
Delete targets routes/service/contracts/tests and any references. **Verify:** grep clean; `pnpm verify`.

### Task 8 — Hardening-lite (B2-D7)
Rate-limit `/v1/sdk/*` keyed by `publishableKey + user_id`; add `allowed_origins` enforcement in the publishable-key plugin (checked only when `Origin` present). **Verify:** `sdk-hardening.int.test.ts` — over-limit → 429; disallowed origin → 403; native (no origin) passes.

### Task 9 — Seed + demo (B2)
Seed workflows keyed by event (`checkout_completed`, etc.); `demo-loop.sh` sends `event_name`. **Verify:** demo loop green.

### Task 10 — Verify + docs
`pnpm verify` green; README updated (workflows/events, no screens/targets). Commit.

---

## Exit checklist
- [ ] Eligibility looks up by `(account_id, event_name)`; `screen_id`/`client_id` gone from contracts and tables.
- [ ] Not-sampled triggers write nothing and don't consume cooldown; sampling covered by tests with a stubbed RNG.
- [ ] One active workflow per `(account, event_name)` enforced by index + publish 409; oldest-wins at runtime.
- [ ] SDK ingest rate-limited by key+user; origin allow-list enforced for browser callers.
- [ ] `target_registry` and targets endpoints deleted; demo loop + `pnpm verify` green.

## Hand-off to B3
Workflows are event-keyed and account-owned. **B3** adds the agentic surface: CLI tokens + device-flow login, an MCP server, config-as-code deploy (with `key` + `managed_by`), and event surfacing.
