# B4 — Reporting, Uploads Scoping & Production-Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish the backend so the frontend can be built and the service can be deployed. Scope **uploads** by account, make **reporting** speak the event/workflow model (overview, reasons, responses feed, trend, dashboard summary, events overview), add **CORS + readiness + production env**, ship an optional **user-data deletion** endpoint (GDPR-lite), and write the **API reference** the frontend consumes. **No UI.**

**Architecture:** Unchanged layering. Reporting already account-scoped in B1; here it's aligned to workflows/events and rounded out. Uploads get an account-prefixed S3 key + ownership checks. CORS distinguishes the two surfaces: `/v1/console/*` allows the dashboard origins (credentialed); `/v1/sdk/*` uses per-account `allowed_origins` (B2). Health gains a deep readiness probe for hosting.

**Tech Stack:** adds `@fastify/cors`. Everything else unchanged.

**Prerequisites:** **B3 merged**. `pnpm verify` green.

---

## Decisions & Edge Cases (binding)

| # | Decision | Rationale / edge case |
|---|---|---|
| B4-D1 | **S3 keys prefixed `acct/<account_id>/…`**; presign issues only within the caller's prefix; `/response` image URLs are validated to sit under the account prefix before storage. | Hard object isolation across accounts; a forged URL for another account is rejected. |
| B4-D2 | **CORS split**: `/v1/console/*` allows origins from `CONSOLE_ORIGINS` (comma list) with credentials; `/v1/sdk/*` reflects an allowed `Origin` per the account's `allowed_origins` (B2), else no CORS headers. `/cli/*` no CORS. | Dashboard needs credentialed cross-origin; SDK ingest is governed per account; CLI is server-to-server. |
| B4-D3 | **Readiness**: `/health` = liveness (200 always if process up); `/ready` = deep (DB `select 1`, S3 head-bucket best-effort). | Container platforms need a real readiness gate distinct from liveness. |
| B4-D4 | **New prod env**: `PUBLIC_BASE_URL` (device-flow `verification_uri`, hosted links), `CONSOLE_ORIGINS`. Finalize the required-in-prod set: `DATABASE_URL, SESSION_SECRET, S3_*, PUBLIC_BASE_URL, CONSOLE_ORIGINS`. | Device-flow and future hosted links need an absolute base; CORS needs the dashboard origin. |
| B4-D5 | **Reporting on workflows/events**: overview (triggers, responses, response-rate, positive-score — all null-safe), reasons (chip counts, ranked), responses feed (cursor-paginated, rating filter), 30-day trend, dashboard summary (per-workflow health + attention rules), events overview (from `seen_events`). All account-scoped, `authContext` (session or token). | Reuses M2/M4 math; only grouping keys change (event vs client). Token auth lets the CLI/MCP read reports too. |
| B4-D6 | **User-data deletion** `DELETE /v1/console/users/:userId/data` (scope `workflows:write`): deletes `responses`/`trigger_log`/`suppression_state` for that `user_id` within the account. Export deferred. | GDPR right-to-be-forgotten, cheap now that `user_id` is indexed; full export is not v1. |
| B4-D7 | **API reference** `docs/api-v1.md`: every endpoint, auth, request/response (linked to `@signal/contracts`). Generated/curated, committed. | The frontend + SDK build against a single written contract; avoids drift. |

---

## Tasks

### Task 1 — Uploads account-scoping (B4-D1)
`uploads/presign.ts`: prefix keys with `acct/<accountId>/`; presign only within it; validate `other_image_url` in `respond.ts` sits under the caller's prefix (else 422). **Verify:** `uploads.int.test.ts` — presign path scoped; cross-account URL rejected.

### Task 2 — CORS (B4-D2)
Register `@fastify/cors` with per-scope config: console (credentialed, `CONSOLE_ORIGINS`), sdk (per-account `allowed_origins`), cli (none). **Verify:** `cors.int.test.ts` — dashboard origin allowed on console; disallowed origin blocked; sdk reflects account origin.

### Task 3 — Reporting on events (B4-D5)
Update `reporting/queries.ts` + routes to group by `workflow`/`event_name`; ensure overview/reasons/responses/trend/dashboard are null-safe and account-scoped; add `GET /v1/console/events/overview`. Accept `authContext` (session or token). **Verify:** `console-reporting.int.test.ts` updated + isolation; token-auth read works.

### Task 4 — Readiness + env (B4-D3,D4)
Add `/ready`; add `PUBLIC_BASE_URL`, `CONSOLE_ORIGINS` to `env.ts` with prod-required checks; wire `PUBLIC_BASE_URL` into device-flow `verification_uri`. Update `.env.example`. **Verify:** `env.test.ts`; `/ready` returns 503 when DB down.

### Task 5 — User-data deletion (B4-D6)
`DELETE /v1/console/users/:userId/data` scoped + account-filtered, transactional. **Verify:** `user-data.int.test.ts` — deletes only that user within the account; isolation.

### Task 6 — API reference (B4-D7)
Write `docs/api-v1.md` covering `/v1/sdk/*`, `/v1/console/*`, `/cli/*`, auth models, and error envelope. **Verify:** every route in `app.ts` appears; links resolve.

### Task 7 — Full verify + demo
`pnpm verify` green; `demo-loop.sh` + a new `console-demo` covering signup → key → deploy (CLI) → track → report end to end. Update `README.md` to "backend complete". **Verify:** both demos pass; clean tree.

---

## Exit checklist
- [ ] Upload keys/URLs are account-prefixed and cross-account access is rejected.
- [ ] CORS: dashboard origin works on console (credentialed); SDK ingest honours per-account origins.
- [ ] Reporting (overview/reasons/responses/trend/dashboard/events) is event-model, null-safe, account-scoped, readable via session or CLI token.
- [ ] `/ready` deep-checks the DB; prod env set finalized incl. `PUBLIC_BASE_URL`, `CONSOLE_ORIGINS`.
- [ ] `docs/api-v1.md` documents the full surface; `pnpm verify` + both demos green.
- [ ] **(GR-1) Migrations frozen** — the single `0000` rewrite era ends here; all further schema changes are incremental migrations.

## Backend done → Frontend phase
With B1–B4 merged the API is complete: signup → keys → `track` → eligibility → responses → reporting, fully account-scoped and agent-drivable. The frontend phase builds on `tokens.css`: **central bottom sheet (web-core) → native shells + web SDK → auth UI → reporting dashboard → landing page.**
