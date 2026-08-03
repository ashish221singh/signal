# B1 — Accounts & Tenancy Core Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the single-tenant BeatRoute backend into a lightweight **multi-account** backend. Anyone can sign up and gets an Account with its own publishable API key; every row is owned by an `account_id` and every query is filtered by it. All BeatRoute-specific machinery (clients table, OAuth client-sync) is deleted. The proven core loop (eligibility → response → dismiss → suppression) keeps working, now account-scoped. **No event re-key yet** (that's B2), **no UI** (that's the frontend phase).

**Architecture:** Same Fastify + Drizzle + Zod stack and the same route/service/repository layering. Two auth surfaces stay: `/v1/sdk/*` moves from a global app-key to a **per-account publishable key**; `/v1/console/*` keeps the stateless cookie session but now resolves an `account_id`. Tenant isolation is a plain `WHERE account_id = ?` in the repository layer, proven by isolation tests — **not** RLS (deferred). The DB is disposable (BeatRoute never shipped), so the schema is **rewritten clean**, not migrated in place.

**Tech Stack:** unchanged — Fastify 5, Drizzle + drizzle-kit, postgres-js, Zod 4, Vitest, Testcontainers, argon2, @fastify/cookie, @fastify/rate-limit. No new dependencies.

**Prerequisites:**
1. Working tree clean; the descoped design doc (`docs/plans/2026-08-03-generic-saas-pivot-design.md`) is the north star.
2. Docker Postgres reachable on :5433. `pnpm verify` green before starting.

---

## Decisions & Edge Cases (binding — do not re-litigate during execution)

| # | Decision | Rationale / edge case |
|---|---|---|
| B1-D1 | **Rewrite the schema clean** — one new `0000` migration; delete old migrations/snapshots. No `ALTER`. | No production data; the DB is disposable. Simpler and less error-prone than incremental alters. |
| B1-D2 | **Account = single owner.** `console_users.account_id` FK; **no memberships table.** Signup creates account + first admin in one transaction. | Lean v1 has no teams. A memberships join is YAGNI until multi-user is needed. |
| B1-D3 | **Publishable keys are not secrets** — stored **plaintext**, unique-indexed for O(1) lookup. Format `pk_live_<24-rand>` / `pk_test_<…>`. Multiple per account allowed; `revoked_at` for rotation. | The key ships in client apps; hashing buys nothing. Rotation without downtime needs >1 active key. |
| B1-D4 | **SDK auth = publishable key** via existing `X-Signal-App-Key` header. A plugin resolves key → `account_id` and sets `request.accountId`; unknown/revoked → 401. Lookups **cached in-memory (60s TTL)** to keep the hot path off the DB. | Replaces the global `SIGNAL_APP_KEYS` env list. Caching mirrors the campaign-cache pattern; eligibility must not add a DB round-trip per call. |
| B1-D5 | **Console account context** resolved in the session guard: session still stores `userId`; guard loads the user, sets `request.accountId`. | Keeps the stateless cookie unchanged; one select already happens per guarded request. |
| B1-D6 | **Delete clients + sync + BeatRoute env entirely** — `clients` table, `campaign.client_ids`, `client_id`/`screen_id`-as-client on `trigger_log`/`responses`'s client fields, `client_status`/`sync/*`/`sync-clients`/`beatrouteClient`, all `BEATROUTE_*` and `SIGNAL_APP_KEYS` env. | Pure BeatRoute glue; none of it survives the pivot. The active-complete CHECK drops its `client_ids >= 1` clause. |
| B1-D7 | **Keep the screen/target trigger model for B1.** Campaigns still key on `target_id`; eligibility still by `(account, screen)`. The event_name re-key is **B2**. | Keeps B1 scope to tenancy only; avoids entangling two large changes. |
| B1-D8 | **Isolation is tested, not RLS-enforced.** Every repository query filters `account_id`; integration tests assert account A cannot read/mutate account B's campaigns, responses, targets, keys. | App-level filter is the lean choice; the test is the guardrail against a forgotten predicate. |
| B1-D9 | **Campaign cache becomes account-aware** — loads all active campaigns across accounts, indexed by `(account_id, screen_id)`. Eligibility resolves account from the key, then looks up `(account, screen)`. | The 60s full-load stays (fine at current scale; Redis is deferred). Only the lookup key changes. |
| B1-D10 | **Signup is open but guarded**: rate-limited (5/min/IP, like login), email unique **globally**, password policy min-8. First user's role = `admin`. | Blunt abuse protection; global-unique email keeps login lookup simple (no per-account email scoping in v1). |

---

## Data model (target `schema.ts`)

New / changed tables (unchanged tables omitted):

```
accounts        id, name, created_at
api_keys        id, account_id→accounts, key (unique), label, environment('live'|'test'),
                created_at, revoked_at?      // publishable keys
console_users   + account_id→accounts        // (email still globally unique)
campaigns       + account_id→accounts, − client_ids ; CHECK drops client_ids clause
target_registry + account_id→accounts        // screen_id unique per (account) now, not global
trigger_log     + account_id→accounts, − client_id
responses       + account_id→accounts, − client_id
suppression_state  (unchanged; scoped via campaign→account)
— DROP clients, client_status enum, integration_status stays (target still used in B1)
```

---

## Tasks

Each task ends green (typecheck + lint + relevant tests). Commit per task.

### Task 1 — Schema rewrite (B1-D1, D6, D2, D3)
- Rewrite `apps/api/src/db/schema.ts`: add `accounts`, `api_keys`; add `account_id` FKs to `campaigns`, `target_registry`, `trigger_log`, `responses`, `console_users`; remove `clients`, `client_status`, `client_ids`, `client_id` columns; amend the `campaigns_active_complete` CHECK (drop the `client_ids` clause); make `target_registry.screen_id` unique per account (`uniqueIndex(account_id, screen_id)`).
- Delete `apps/api/drizzle/*` and regenerate a single `0000` migration (`pnpm --filter @signal/api db:generate`).
- **Verify:** `db:migrate` on a fresh Docker Postgres succeeds; `schema.int.test.ts` (rewritten) asserts the new tables/constraints.

### Task 2 — Env cleanup (B1-D6)
- In `env.ts` remove `SIGNAL_APP_KEYS` and all `BEATROUTE_*`; drop them from `Env`, defaults, and the production-required check. Update `.env.example`.
- **Verify:** `env.test.ts` updated; app boots without those vars.

### Task 3 — Contracts (B1-D2, D6)
- `packages/contracts`: add `signupRequest`, `account`, `apiKey` schemas; remove `client_id` from eligibility/response/dismiss request+response schemas and from the clients console contract (delete `console/clients.ts`).
- **Verify:** contracts unit tests updated and green.

### Task 4 — Accounts & keys service/repo (B1-D2, D3)
- New `accounts/service.ts` + repo: `createAccount`, `createConsoleUser` (in one tx for signup), `issueKey`, `lookupAccountByKey`, `revokeKey`.
- Key generator: `pk_<env>_<base62(24)>`.
- **Verify:** unit tests for key format + lookup; integration test for signup tx.

### Task 5 — Signup route (B1-D2, D10)
- `POST /v1/console/auth/signup` (public, rate-limited 5/min/IP): validate, reject duplicate email (409), create account + admin user + a default `live` publishable key in one tx, issue session, return `{ account, user, publishableKey }`.
- **Verify:** integration test — signup → session cookie set → `/me` works; duplicate email → 409.

### Task 6 — Publishable-key auth plugin (B1-D4)
- Replace `plugins/appKeyAuth.ts` with `plugins/publishableKeyAuth.ts`: read `X-Signal-App-Key`, resolve account via a cached lookup (`Map<key, {accountId, expiresAt}>`, 60s TTL, revoked keys miss), set `request.accountId`; missing/invalid → 401 same error shape.
- Wire it into the `/v1/sdk` scope in `app.ts`; drop `env.appKeys` usage.
- **Verify:** `publishableKeyAuth.test.ts` — valid key sets accountId; revoked/unknown → 401; cache respects TTL.

### Task 7 — Console session guard resolves account (B1-D5)
- `plugins/sessionGuard.ts`: after reading `userId`, load the user, set `request.accountId`; stale user → 401.
- **Verify:** `sessionGuard.test.ts` updated.

### Task 8 — Account-scope console queries (B1-D8)
- Thread `request.accountId` through campaigns, targets, reporting, dashboard services; add `eq(table.account_id, accountId)` to every read and write; new rows stamp `account_id`.
- Delete `routes/console/clients.ts`, its service, and the per-client reporting endpoint/queries.
- **Verify:** existing console integration tests updated to create data under an account; **new isolation tests** (account A vs B) for campaigns, targets, reporting.

### Task 9 — Account-scope the hot path + cache (B1-D4, D7, D9)
- `campaigns/loader.ts` + `cache.ts`: select `account_id`, index by `(account_id, screen_id)`.
- `eligibility/service.ts`: use `request.accountId`; look up cache by `(accountId, screenId)`; stamp `account_id` on `trigger_log`; drop `client_id`.
- `feedback/respond.ts` + `dismiss.ts`: stamp `account_id`, drop `client_id`; suppression unchanged.
- **Verify:** `eligibility.int.test.ts`, `respond.int.test.ts`, `dismiss.int.test.ts` updated; isolation test — a key for account A can't trigger account B's campaign.

### Task 10 — Remove sync + BeatRoute (B1-D6)
- Delete `sync/`, `scripts/sync-clients.ts`, `sync/beatrouteClient*`, and their tests. Remove any `docker-compose` BeatRoute mock and CI steps.
- **Verify:** grep shows no `beatroute`/`clients` references remain; `pnpm verify` green.

### Task 11 — Dev seed + bootstrap (B1-D9)
- Rewrite `scripts/seed-dev.ts`: create one dev account + `admin@signal.dev` user + a `pk_test_*` key + the existing sample campaigns under that account. Replace `create-admin.ts` with `create-account.ts` (bootstrap an account + admin from CLI) or fold into seed.
- Update `README.md` quickstart and `scripts/demo-loop.sh` to obtain and send a real publishable key.
- **Verify:** `./scripts/demo-loop.sh` prints ALL SCENARIOS PASSED against a seeded account.

### Task 12 — Full verify + docs
- `pnpm verify` green (typecheck + lint + unit + integration).
- Update `README.md` status + layout (accounts, no clients/sync).
- **Verify:** clean `pnpm verify`; demo loop green; commit.

---

## Exit checklist
- [ ] Fresh `0000` migration applies on an empty DB; no `clients` table, no `client_id`/`client_ids` anywhere.
- [ ] Signup creates account + admin + publishable key in one tx; session works end to end.
- [ ] SDK routes authenticate by publishable key → `account_id`, cached; unknown/revoked → 401.
- [ ] Every console + SDK query is account-scoped; isolation tests (A vs B) pass for campaigns, targets, responses, reporting, and the hot path.
- [ ] No `BEATROUTE_*` / `SIGNAL_APP_KEYS` env; no `sync/` module; no per-client reporting.
- [ ] `./scripts/demo-loop.sh` → ALL SCENARIOS PASSED under a seeded account; `pnpm verify` green.

## Hand-off to B2
After B1: campaigns are account-owned and keyed by `(account, screen)`. **B2** renames `campaigns → workflows`, swaps the screen trigger for `event_name`, adds per-workflow sampling, and enforces one active workflow per `(account, event_name)`.
