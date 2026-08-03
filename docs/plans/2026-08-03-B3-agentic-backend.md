# B3 — Agentic Backend (CLI · MCP · Config-as-Code) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make everything a PM/dev can do reachable from the terminal and from an AI agent. Add **CLI tokens** + **device-flow login**, a unified **Bearer-token auth** path over the existing console API, a **config-as-code deploy** endpoint (idempotent upsert, `managed_by` lock), **event surfacing**, an **MCP server** package exposing the API as tools, and a minimal **CLI** (`login`/`whoami`/`deploy`/`workflows`). This is the product's differentiator — and it's thin because it sits on the finished B1/B2 API. **No end-user UI**; the device-flow approval page is a minimal server-rendered page, not the React dashboard.

**Architecture:** New workspace packages `packages/mcp` (`@signal/mcp`) and `packages/cli` (`@signal/cli`), both depending on `@signal/contracts`. The API gains a **dual auth**: a request carries either a console **cookie session** or an `Authorization: Bearer cli_…` token; both resolve to an `authContext { accountId, scopes }` consumed by `/v1/console/*`. Device-flow is the OAuth 2.0 Device Authorization Grant. The MCP server is a thin stdio process that authenticates with a CLI token and calls the HTTP API (no direct DB access), so it inherits all validation/isolation.

**Tech Stack:** adds `@modelcontextprotocol/sdk` (MCP server), `commander` (CLI), `@fastify/static` or inline HTML for the approval page. Everything else unchanged.

**Prerequisites:** **B2 merged** (event-keyed workflows). `pnpm verify` green.

---

## Decisions & Edge Cases (binding)

| # | Decision | Rationale / edge case |
|---|---|---|
| B3-D1 | **CLI tokens ARE secrets** → stored **sha256-hashed** (high-entropy random, no argon2 needed), format `cli_<base62(32)>`. Table `cli_tokens(id, account_id, token_hash, name, scopes text[], created_at, last_used_at, expires_at, revoked_at)`. Default expiry 90d, revocable. | Unlike publishable keys, a CLI token can mutate; treat it like a password-equivalent but cheap to verify. |
| B3-D2 | **Scopes**: `workflows:read`, `workflows:write`, `responses:read`, `deploy`. Device-flow issues a token with all four; scope checks are enforced per route. | Least-privilege ready; today one token type, but routes assert scopes so tightening later is free. |
| B3-D3 | **Device flow**: `POST /v1/cli/device/code` → `{device_code, user_code, verification_uri, interval, expires_in}`; user opens `verification_uri` (a **minimal server-rendered page**), logs in with session (or is already logged in) and approves → binds `account_id`; CLI polls `POST /v1/cli/device/token` with `device_code` → `authorization_pending` until approved, then the `cli_…` token once. Table `device_authorizations`. | Standard, browser-safe; the approval page is server-rendered so B3 does not depend on the React dashboard. |
| B3-D3b | **(GR-2) Server-rendered auth pages** — B3 also serves plain HTML `/signup`, `/login`, `/cli/approve` (lightly styled with `tokens.css`), **not** the React app. So signup → login → device-approval → deploy works standalone, before the frontend exists. The dashboard later supersedes these for reporting; they remain the always-available auth fallback. | Otherwise the "backend-first" phase isn't actually usable end-to-end (agentic login needs a browser session). |
| B3-D4 | **Interim credential login** `POST /v1/cli/login` (email+password, rate-limited) → CLI token, for headless/CI and tests. **(GR-10)** Gated by `ALLOW_PASSWORD_CLI_LOGIN` — default on in dev/test, **off in production** so device-flow is the only prod path. | Lets B3 be exercised end-to-end headlessly; the prod gate keeps a standing password→token mint out of production. |
| B3-D5 | **Unified auth**: a shared `resolveAuth` sets `request.auth = {accountId, scopes, via:'session'|'token'}`. Session ⇒ all scopes. `/v1/console/*` accept either. | One authorization model; MCP/CLI hit the same endpoints humans do. |
| B3-D6 | **config-as-code deploy** `POST /v1/console/deploy` (scope `deploy`): body = `{ workflows: [{ key, event_name, … }] }`. Upsert by `(account_id, key)`: create/update, set `managed_by='code'`, publish per `status`. Workflows with `managed_by='code'` **absent** from the payload are **archived** (prune), never hard-deleted. Console/MCP mutations to a `managed_by='code'` workflow are **rejected 409** (except via deploy). **(GR-5)** Deploy honours the B2 one-active-per-`(account,event_name)` rule: an item whose event already has an *active console-managed* workflow fails with `event_conflict` (naming the incumbent); the rest of the deploy still applies — **partial success is reported per item**. | Declarative, idempotent, git-friendly. `key` is the stable identity; prune = deactivate-not-delete. Lock prevents drift; deploy never silently steals an event from a console workflow. |
| B3-D7 | **Event surfacing** must not add a DB write to the hot path. Maintain an in-memory per-account **seen-set** (LRU) in the eligibility service; on a **first sighting** of an `event_name` this process hasn't recorded, enqueue a best-effort async upsert into `seen_events(account_id, event_name, first_seen_at, last_seen_at, hit_count)`. `GET /v1/console/events` reads it. | Preserves B1-D4 (hot path off the DB): steady-state calls hit only memory; the DB sees at most one upsert per new event per process. |
| B3-D8 | **MCP server is HTTP-only** (no DB import). Tools: `create_workflow`, `update_workflow`, `list_workflows`, `list_events`, `set_rules`, `publish_workflow`, `pause_workflow`, `get_overview`, `get_responses`. Auth via `SIGNAL_TOKEN` (a CLI token) + `SIGNAL_API_URL`. | Thin, safe, inherits validation/isolation. Ships runnable: `npx @signal/mcp`. |
| B3-D9 | **CLI scope for B3** = `login` (device flow), `login --password` (interim), `whoami`, `deploy <file>`, `workflows list`. **`init`/SDK-install is deferred to the frontend phase** (needs the web SDK). | The CLI is tooling, not UI; the SDK-install half depends on the not-yet-built web-core SDK. |

---

## Data model (delta on B2)

```
cli_tokens            id, account_id→accounts, token_hash unique, name, scopes text[],
                      created_at, last_used_at?, expires_at, revoked_at?
device_authorizations device_code (hash) unique, user_code unique, account_id? (set on approve),
                      status('pending'|'approved'|'denied'|'expired'), created_at, expires_at
seen_events           account_id→accounts, event_name, first_seen_at, last_seen_at, hit_count
                      primary key (account_id, event_name)
workflows             + key text?, + managed_by('console'|'code') default 'console'
                      uniqueIndex (account_id, key) WHERE key IS NOT NULL
```

---

## Tasks

### Task 1 — Schema (B3-D1,D3,D6,D7)
Add `cli_tokens`, `device_authorizations`, `seen_events`; add `key`+`managed_by` to `workflows` with the partial unique index. Migration. **Verify:** `schema.int.test.ts`.

### Task 2 — Contracts (B3-D2,D6,D8)
CLI-token, device-flow, deploy payload (`workflows[]` with `key`), events, scopes enums. **Verify:** contract tests.

### Task 3 — Token service (B3-D1,D2)
Issue (`cli_…`, sha256 store), verify (constant-time), revoke, list; scope helpers. **Verify:** unit tests — format, hash lookup, expiry/revocation.

### Task 4 — Unified auth (B3-D5)
`resolveAuth` decorator: Bearer token → account+scopes (updates `last_used_at`); else session → account + all scopes; else 401. Add a `requireScope(scope)` guard. Apply to `/v1/console/*`. **Verify:** `auth.int.test.ts` — token vs session vs none; scope denial → 403.

### Task 5 — Device flow + interim login + server-rendered auth pages (B3-D3,D3b,D4)
`/v1/cli/device/code`, the server-rendered approval page (`GET /cli/approve?user_code=`, session-guarded, POST approve/deny), `/v1/cli/device/token` polling; `/v1/cli/login` (password → token, rate-limited, `ALLOW_PASSWORD_CLI_LOGIN` prod-gated). **(GR-2)** Plain server-rendered `/signup` + `/login` pages (styled via `tokens.css`, not React) that call the B1 signup + login endpoints, so the flow works before the frontend. **Verify:** `device-flow.int.test.ts` — pending→approved→token issued once, expiry, interim login gated off in prod; the HTML pages render and post successfully.

### Task 6 — Key & token management (B3-D1)
Console endpoints: list/create/revoke publishable keys and CLI tokens (with `allowed_origins` from B2). **Verify:** integration + isolation (A can't see B's keys/tokens).

### Task 7 — config-as-code deploy (B3-D6)
`POST /v1/console/deploy`: idempotent upsert by `(account, key)`, `managed_by='code'`, publish per status, prune absent code-managed workflows (archive), lock console/MCP edits on code-managed (409), and **(GR-5)** enforce event-uniqueness with per-item `event_conflict` + partial-success reporting. **Verify:** `deploy.int.test.ts` — create/update idempotency (same payload twice = no-op), prune, lock, event_conflict partial success, isolation.

### Task 8 — Event surfacing (B3-D7)
In-memory per-account seen-set + async upsert into `seen_events`; `GET /v1/console/events`. **Verify:** `events.int.test.ts` — event appears after an eligibility call; no per-call DB write in steady state (assert via spy/counter).

### Task 9 — MCP server package (B3-D8)
`packages/mcp` (`@signal/mcp`): stdio server, tools over HTTP using `SIGNAL_TOKEN`/`SIGNAL_API_URL`, typed via contracts. **Verify:** tool-level tests against a running API (create→publish→get_overview round-trip).

### Task 10 — CLI package (B3-D9)
`packages/cli` (`@signal/cli`): `login` (device), `login --password`, `whoami`, `deploy <file>`, `workflows list`. Reads/writes `~/.signal/config.json`. **Verify:** CLI e2e against the API — login → deploy a `signal.config.ts` fixture → workflows list shows it.

### Task 11 — Verify + docs + CI (B3, GR-7)
`pnpm verify` green; **extend root verify + CI matrix to typecheck/lint/test `@signal/mcp` and `@signal/cli`** (their tests run against an ephemeral API + Testcontainers Postgres). `docs/` note on CLI/MCP/deploy usage. Commit.

---

## Exit checklist
- [ ] CLI token issued via device-flow (and interim password login); Bearer auth works on `/v1/console/*` with scope enforcement.
- [ ] `deploy` is idempotent, prunes absent code-managed workflows, and locks them against console/MCP edits.
- [ ] `seen_events` populates from eligibility with **no** steady-state per-call DB write; `GET /events` lists them.
- [ ] `@signal/mcp` round-trips create→publish→report; `@signal/cli` logs in and deploys.
- [ ] Isolation holds for keys, tokens, deploy, events; `pnpm verify` green.

## Hand-off to B4
The agentic surface is complete. **B4** scopes uploads by account, finalizes reporting on the event model, adds CORS + readiness + prod env, and writes the API reference the frontend will consume.
