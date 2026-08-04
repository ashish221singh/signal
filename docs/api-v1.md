# Signal API v1 Reference

The complete HTTP surface of the Signal Backend after **B1–B4**. This is the
single written contract the frontend and SDKs build against. All request/response
bodies are validated by Zod schemas exported from `@signal/contracts` — the
schema names below are the source of truth; this document links routes to them.

- **Version:** `SIGNAL_API_VERSION = "0.1.0"` (surfaced by `GET /health`).
- **Content type:** JSON in and out unless noted. Empty successes use `204`.
- **Case:** wire fields are `snake_case`.

## Surfaces & auth models

| Surface | Prefix | Auth | CORS (B4-D2) |
|---|---|---|---|
| **SDK ingest** | `/v1/sdk/*` | `X-Signal-App-Key: pk_…` publishable key → `account_id` (B1-D4). Per-account browser origin allow-list enforced only when an `Origin` header is present (B2-D7). | Reflects the request `Origin` when it is on the account's `allowed_origins` (empty list ⇒ any); otherwise no CORS headers. |
| **Console** | `/v1/console/*` | Unified auth (B3-D5): a signed `signal_session` cookie (⇒ **all** scopes) **or** `Authorization: Bearer cli_…` CLI token (⇒ the token's scopes). Missing/invalid → 401. Per-route `requireScope` → 403 `insufficient_scope`. | Allows the `CONSOLE_ORIGINS` list **with credentials**. |
| **CLI / device-flow / auth pages** | root (`/v1/cli/*`, `/signup`, `/login`, `/cli/approve`) | Public (server-to-server or session-self-checked). `/cli/approve` reads the console session and redirects to `/login` when absent. | None. |
| **Ops** | `/health`, `/ready` | Public. | None. |

### Scopes (B3-D2)

`workflows:read`, `workflows:write`, `responses:read`, `deploy`. Device-flow and
the interim password login mint **all four**; routes gate per scope so tightening
later is free. A **session** always carries all scopes.

### Error envelope

Every non-2xx response uses:

```json
{ "error": { "code": "string", "message": "string" } }
```

Common codes: `unauthorized` (401), `insufficient_scope` (403),
`origin_not_allowed` (403), `not_found` / `campaign_not_found` / `unknown_trigger`
(404), `invalid_body` / `invalid_query` / `invalid_rating` / `invalid_image_url`
(422), `rate_limited` (429), `internal` (500). Fastify parse/validation failures
are normalized to `422 invalid_body` (M1-D18); rate-limit rejections to
`429 rate_limited` (M2-D16).

---

## Ops

### `GET /health` — liveness
Always `200` while the process is up; touches no dependency.
**Response:** `healthResponseSchema` — `{ status: "ok", version }`.

### `GET /ready` — readiness (B4-D3)
Deep probe. DB `select 1` is **required**; S3 head-bucket is **best-effort**.
**Response:** `readyResponseSchema` — `{ status: "ready"|"not_ready", checks: { db: "ok"|"down", s3: "ok"|"down"|"skipped" } }`.
`200` when the DB is reachable; `503 not_ready` when the DB check fails (S3 failure
is reported but never fails readiness).

---

## SDK ingest — `/v1/sdk/*`

Auth: `X-Signal-App-Key`. All bodies are hardened; ingest is rate-limited per
`(publishable key + user_id)` (B2-D7) → `429 rate_limited` over the limit.

### `GET /v1/sdk/eligibility`
Resolve whether to show an ask for `(account, event_name, user)`.
**Query:** `eligibilityQuerySchema` — `event_name`, `user_id`, optional `context`,
`session_age_days`.
**Response:** `200` `eligibilityConfigSchema` (the ask config incl. `trigger_id`)
when eligible; `204` when not; `422 invalid_query` on a bad query.

### `POST /v1/sdk/response`
Record a rating for a granted trigger. Idempotent on `trigger_id` (M1-D2).
**Body:** `responseBodySchema` — `trigger_id`, `rating_value`, optional
`chip_selected`, `other_text`, `other_image_url`, `location`, `device_os`,
`app_version`, `session_age_days`, `shown_at`, `responded_at`.
**Response:** `204` on success; `404 unknown_trigger`; `422 invalid_rating`
(rating outside the workflow scale); `422 invalid_image_url` when
`other_image_url` is not under the caller's `acct/<accountId>/` prefix (B4-D1).

### `POST /v1/sdk/dismiss`
Record a dismissal (starts the cooldown).
**Body:** `dismissBodySchema` — `trigger_id`, `shown_at`, `dismissed_at`.
**Response:** `204`; `404 unknown_trigger`.

### `POST /v1/sdk/uploads`
Presign a short-lived S3 PUT for a feedback image. The key is issued under the
caller's account prefix `acct/<accountId>/feedback/…` (B4-D1).
**Body:** `uploadRequestSchema` — `content_type` (`image/jpeg|png|webp`).
**Response:** `200` `uploadTicketSchema` — `{ upload_url, object_url, key }`;
`422 invalid_body` for a non-image type.

### `POST /v1/sdk/internal/refresh-cache`
Operational/test hook: force an immediate reload of the active-workflow SDK cache
(so a publish/pause is visible without waiting on the 60s timer). App-key guarded.
**Response:** `204`.

---

## Console — `/v1/console/*`

Unified auth (session or Bearer token). Below, **Scope** is the `requireScope`
gate; “none” means no explicit gate (any authenticated principal — a session
always passes, a token passes if it authenticated).

### Auth subtree — `/v1/console/auth/*` (no session required)

| Method & path | Purpose | Request → Response |
|---|---|---|
| `POST /v1/console/auth/signup` | Create account + admin user + first publishable key; sets the session cookie. Rate-limited. | `signupRequestSchema` → `201 signupResponseSchema` (incl. `publishable_key`). Duplicate email → 409. |
| `POST /v1/console/auth/login` | Log in; sets the session cookie. Rate-limited 5/min/IP (M2-D4). | `loginRequestSchema` → `200 sessionUserSchema`. Bad creds → `401 invalid_credentials` (no enumeration). |
| `POST /v1/console/auth/logout` | Clear the session cookie. | → `204`. |
| `GET /v1/console/auth/me` | Current session user. | → `200 sessionUserSchema`; `401` without a session. |

### Workflows — `/v1/console/workflows` (guarded)

Console-managed workflow builder + lifecycle. `code`-managed workflows (owned by
`signal deploy`) are locked against console/MCP edits (B3-D6 → 409). Scope: none
(gated by the unified auth; session or token).

| Method & path | Purpose | Request → Response |
|---|---|---|
| `POST /v1/console/workflows` | Create a draft. `created_by` falls back to `cli-token` for token auth. | `workflowDraftCreateSchema` → `201 workflowSchema`. |
| `GET /v1/console/workflows` | List workflows (optional `?include=`). | → `200` array of `workflowListItemSchema`. |
| `GET /v1/console/workflows/:id` | Fetch one. | → `200 workflowSchema`; `404 not_found`. |
| `PATCH /v1/console/workflows/:id` | Edit draft fields. | `workflowUpdateSchema` → `200 workflowSchema`; `409` if `code`-managed. |
| `POST /v1/console/workflows/:id/publish` | Publish (→ active). Enforces one active workflow per `(account, event_name)`. | → `200 workflowSchema`; `409 overlap` on an event already active (B2-D3). |
| `POST /v1/console/workflows/:id/pause` | Pause. | → `200 workflowSchema`. |
| `POST /v1/console/workflows/:id/resume` | Resume a paused workflow. | → `200 workflowSchema`; `409` overlap. |
| `POST /v1/console/workflows/:id/archive` | Archive. | → `200 workflowSchema`. |
| `DELETE /v1/console/workflows/:id` | Delete a draft. | → `204`; `404 not_found`. |

### Hosted-link preview (guarded — scope `workflows:read`, F2-D16)

Mints a short-lived signed link that renders a workflow's sheet in a standalone
page for the agent's "instant preview" / share-anywhere surveys. Preview is
**read-only** — it never persists a response and needs no publishable key or
schema change. The token is a stateless HMAC grant (signed with `SESSION_SECRET`,
`exp` ≈ 30 min) embedding `{account_id, workflow_id, mode:'preview'}`. Contract:
`@signal/contracts` (`console/workflows.ts` → `previewRequestSchema`/`previewResponseSchema`).

| Method & path | Purpose | Response |
|---|---|---|
| `POST /v1/console/preview` | Mint a preview link for a workflow the account owns. | `previewRequestSchema` (`{workflow_id}`) → `201 previewResponseSchema` (`{token, preview_url, expires_at}`); `404 not_found` if the workflow is not in the account. |

### Hosted-link preview surface — `/s/preview/*` (public, F2-D7)

Public, unauthenticated: the signed token IS the grant, and the workflow lookup is
scoped to the token's `account_id`, so a token can only ever render its own
account's workflow. Serves a self-contained HTML harness that loads the bundled
web-core IIFE and mounts the config with a **non-persisting** preview `SheetHost`.

| Method & path | Purpose | Response |
|---|---|---|
| `GET /s/preview/:token` | Render the standalone preview harness for a valid token. | `200 text/html` (the sheet page); expired/invalid/wrong-account/incomplete → `404 text/html` (friendly page, not a stack trace). |
| `GET /s/preview/web-core.js` | The bundled web-core IIFE artifact the harness mounts (F2-D14). | `200 application/javascript` (cached 1h). |

### Reporting (guarded — scope `responses:read`, B4-D5)

All account-scoped and null-safe; readable via session **or** a token carrying
`responses:read` (a token missing it → 403). Contracts live in
`@signal/contracts` (`console/reporting.ts`).

| Method & path | Purpose | Response |
|---|---|---|
| `GET /v1/console/workflows/:id/overview` | Per-workflow triggers/responses + derived ratios. | `200 campaignOverviewSchema`; `404 not_found`. |
| `GET /v1/console/workflows/:id/reasons` | Ranked chip selections with shares. | `200 reasonsSchema`; `404 campaign_not_found`. |
| `GET /v1/console/workflows/:id/responses` | Cursor-paginated response feed, filterable by score band. | `200 responseFeedSchema`; `422 invalid_query`; `404 campaign_not_found`. Query: `responseFeedQuerySchema`. |
| `GET /v1/console/workflows/:id/trend` | 30-day per-UTC-day positive-score trend. | `200 trendSchema`; `404 campaign_not_found`. |
| `GET /v1/console/dashboard` | Console landing summary — KPIs, attention strip, active+paused health list. | `200 dashboardSummarySchema`. |
| `GET /v1/console/events/overview` | Account-wide triggers/responses rolled up per `event_name` (B4-D5). | `200 eventsOverviewSchema`. |

### Key & token management (guarded)

Account-scoped isolation (A can never see/revoke B's keys/tokens). Publishable
keys are not secrets (plaintext on list); CLI tokens are secrets (plaintext only
in the create response). Contracts in `console/accounts.ts` + `console/agentic.ts`.

| Method & path | Scope | Request → Response |
|---|---|---|
| `GET /v1/console/keys` | `workflows:read` | → `200 { keys: ApiKey[] }`. |
| `POST /v1/console/keys` | `workflows:write` | `apiKeyCreateSchema` → `201 apiKeySchema`. |
| `DELETE /v1/console/keys/:id` | `workflows:write` | → `204`; `404 not_found`. |
| `GET /v1/console/cli-tokens` | `workflows:read` | → `200 { tokens: CliToken[] }` (no plaintext). |
| `POST /v1/console/cli-tokens` | `workflows:write` | `cliTokenCreateSchema` → `201 cliTokenCreatedSchema` (plaintext once). |
| `DELETE /v1/console/cli-tokens/:id` | `workflows:write` | → `204`; `404 not_found`. |

### Deploy — config-as-code (guarded — scope `deploy`, B3-D6)

| Method & path | Purpose | Request → Response |
|---|---|---|
| `POST /v1/console/deploy` | Idempotent upsert/prune of `code`-managed workflows by `(account, key)`. Honors event-uniqueness — a conflicting item fails with `event_conflict` (naming the incumbent) while the rest apply (partial success, GR-5). Refreshes the SDK cache after apply. | `deployRequestSchema` → `200 deployResponseSchema` (per-item results). |

### Event surfacing (guarded — scope `workflows:read`, B3-D7)

| Method & path | Purpose | Response |
|---|---|---|
| `GET /v1/console/events` | The set of `event_name`s the account has fired eligibility checks for (surfaced off the hot path). | `200 seenEventListSchema`. |

### User-data deletion (guarded — scope `workflows:write`, B4-D6)

| Method & path | Purpose | Response |
|---|---|---|
| `DELETE /v1/console/users/:userId/data` | GDPR-lite. Transactionally delete the user's `responses`/`trigger_log`/`suppression_state` **within the caller's account only**. Idempotent. | `200 { user_id, deleted: { responses, trigger_log, suppression_state } }`. |

---

## CLI / device-flow / auth pages (root, public)

Contracts in `console/agentic.ts`. Device grant is the prod path; interim
password login is prod-gated (B3-D4, GR-10).

| Method & path | Purpose | Request → Response |
|---|---|---|
| `POST /v1/cli/device/code` | Start the OAuth Device Authorization Grant. | → `201 deviceCodeResponseSchema` (`device_code`, `user_code`, `verification_uri` built from `PUBLIC_BASE_URL`, `interval`, `expires_in`). |
| `POST /v1/cli/device/token` | CLI polls with the `device_code`. | `deviceTokenRequestSchema` → `200 deviceTokenResponseSchema` when approved; `428 authorization_pending`; `403 access_denied`; `410 expired_token`; `404 invalid_grant`. |
| `POST /v1/cli/login` | Interim password → CLI token. Rate-limited 5/min/IP; **disabled in production** unless `ALLOW_PASSWORD_CLI_LOGIN=true`. | `cliLoginRequestSchema` → `200 cliLoginResponseSchema`; `401 invalid_credentials`; `403 password_login_disabled`. |
| `GET /signup` | Server-rendered signup page (GR-2). | → `200 text/html`. |
| `GET /login?next=` | Server-rendered login page. | → `200 text/html`. |
| `GET /cli/approve?user_code=` | Session-guarded device-approval page; redirects to `/login` when unauthenticated. | → `200 text/html`; `404` invalid/expired code. |
| `POST /cli/approve` | Approve/deny a device code for the session's account. | form body → `200 text/html` (approved/denied) or `404`. |

---

## Route inventory (every route registered in `app.ts`)

`/health` · `/ready` · `/v1/sdk/eligibility` · `/v1/sdk/response` ·
`/v1/sdk/dismiss` · `/v1/sdk/uploads` · `/v1/sdk/internal/refresh-cache` ·
`/v1/console/auth/signup` · `/v1/console/auth/login` · `/v1/console/auth/logout` ·
`/v1/console/auth/me` · `/v1/console/workflows` (POST, GET) ·
`/v1/console/workflows/:id` (GET, PATCH, DELETE) ·
`/v1/console/workflows/:id/{publish,pause,resume,archive}` ·
`/v1/console/workflows/:id/{overview,reasons,responses,trend}` ·
`/v1/console/dashboard` · `/v1/console/events/overview` · `/v1/console/keys` (GET,
POST) · `/v1/console/keys/:id` (DELETE) · `/v1/console/cli-tokens` (GET, POST) ·
`/v1/console/cli-tokens/:id` (DELETE) · `/v1/console/deploy` · `/v1/console/events`
· `/v1/console/users/:userId/data` (DELETE) · `/v1/cli/device/code` ·
`/v1/cli/device/token` · `/v1/cli/login` · `/signup` · `/login` · `/cli/approve`
(GET, POST).
