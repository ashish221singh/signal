# Signal

In-app CSAT/CES feedback system for BeatRoute's field-rep app. One system, three parts, one name:

- **Signal Console** — internal admin tool for PMs to build/manage feedback workflows (no engineering after initial setup)
- **Signal Backend** — standalone service: workflow config, event-keyed eligibility, suppression, response storage, reporting
- **Signal SDK** — Android library (`com.beatroute:signal-sdk`): bottom sheet UI + event hooks + networking (**deferred** — see `sdk-android/DEFERRED.md`)

## Source of truth

- [`docs/signal-spec-v1.md`](docs/signal-spec-v1.md) — full product & technical spec (v1.1, locked). Read this first; all build work traces back to it.
- [`docs/signal-architecture-v1.md`](docs/signal-architecture-v1.md) — system architecture (layering, hot path, idempotency).
- [`docs/plans/`](docs/plans/) — milestone implementation plans.

## Status

- **Spec:** locked (v1.1, 2026-07-08)
- **Build:** B2 (Event Re-key) complete — the trigger model is now **generic and
  event-keyed**: a **workflow** listens for a named **event** (`signal.track("checkout_completed")`),
  and eligibility resolves on `(account_id, event_name)`. Screens/targets are gone.
  Workflows add per-workflow **sampling** (a not-sampled ask is invisible and does not
  consume cooldown) and a **min-session-age** gate, and enforce **one active workflow per
  event per account** (publish overlap → 409). The public SDK ingest is hardened-lite:
  a per-`(key + user)` rate limit and a per-account browser origin allow-list (native SDKs
  send no `Origin` and always pass). Built on B1's account tenancy + publishable keys.
- **Not yet:** the agentic surface (B3) and reporting/CORS/deploy hardening (B4). No web
  UI yet (frontend phase). The committed Android SDK is **deferred** (`sdk-android/DEFERRED.md`).

## Planned layout (per spec §12 build sequence)

```
Signal/
├── docs/          specs, plans, API contracts
├── apps/api/      Signal Backend service — accounts, publishable keys, /eligibility /response /dismiss, workflow CRUD, reporting
├── packages/contracts/  shared Zod API schemas
├── sdk-android/   com.beatroute:signal-sdk (bottom sheet, hooks, networking, local suppression cache)
└── console/       Signal Console (workflow builder + reporting dashboard — frontend phase)
```

Subfolders are created as each build phase starts — the API contract (spec §8) gets locked first.

## Development

**Prerequisites:** Node 22+ (`nvm use`), pnpm 10 (`corepack enable`), Docker.

```bash
pnpm install          # install all workspace deps
docker compose up -d  # local Postgres on :5433
cp .env.example .env  # local config
pnpm --filter @signal/api dev   # API on :3000
pnpm verify           # typecheck + lint + tests (what CI runs)
```

**Layout:** `apps/api` (Fastify backend) · `packages/contracts` (shared Zod API schemas) ·
`apps/console` (React SPA, from Milestone 2) · `sdk-android/` (Kotlin SDK, from Milestone 3) ·
`docs/` (spec, architecture, plans) · `design/` (design system, tokens, logo).

## Core loop demo

Proves the complete product loop end to end — eligible → shown → answered/dismissed →
suppressed → correctly re-eligible or never again — against real Postgres:

```bash
docker compose up -d
pnpm --filter @signal/api db:migrate
pnpm --filter @signal/api dev &
./scripts/demo-loop.sh   # prints ALL SCENARIOS PASSED
```

`demo-loop.sh` is self-contained: it signs up a fresh account to obtain a real
publishable key, builds + publishes event-keyed workflows under that account
through the Console API, then drives the full SDK loop with that key — no pre-seed
needed.

## Console API

The Console API is the backend for the Signal Console — the internal admin surface
PMs use to build and manage feedback **workflows**. A workflow listens for a named
**event** and, when eligible, presents a CSAT/CES ask. All routes live under
`/v1/console/*`. Everything except `/v1/console/auth/*` requires a valid session
cookie.

### Accounts & signup

Signup is open (rate-limited 5/min/IP). It creates an **account**, its first
**admin** user, and a default **publishable key** (`pk_live_…`) in one transaction,
then issues a session:

```bash
curl -X POST http://localhost:3000/v1/console/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"pm@signal.local","password":"changeme123","name":"PM","account_name":"Acme"}'
# → { account, user, publishable_key }
```

Email is globally unique (a duplicate → `409 email_taken`); password must be at
least 8 characters. To bootstrap an account from the CLI instead:

```bash
pnpm --filter @signal/api create-account -- \
  --email pm@signal.local --name PM --password changeme123 --account Acme
```

Publishable keys are **not secrets** (they ship in client apps): stored plaintext,
unique-indexed, format `pk_<live|test>_<24>`, with `revoked_at` for rotation.

### Auth (cookie session)

- `POST /v1/console/auth/signup` `{ email, password, name, account_name }` → creates
  the account + admin + key, sets the session cookie, returns the above. 5/min/IP.
- `POST /v1/console/auth/login` `{ email, password }` → on success sets a signed,
  httpOnly cookie `signal_session` (`sameSite=strict`, `secure` in production,
  12h expiry) and returns the user. Rate-limited to **5/min/IP**.
- `POST /v1/console/auth/logout` → clears the cookie (204).
- `GET /v1/console/auth/me` → the current user, or 401.

The session guard resolves the caller's `account_id` from their user, and every
`/v1/console/*` query is filtered by it. No user enumeration: a wrong password and
an unknown email both return `401 invalid_credentials`.

### SDK auth (publishable key) + ingest hardening

`/v1/sdk/*` authenticates by the account's publishable key in the
`X-Signal-App-Key` header (unknown/revoked → 401). The key resolves to an
`account_id` (cached 60s) and every SDK query — eligibility, response, dismiss —
is scoped to that account.

Because publishable keys are public, the SDK ingest is hardened-lite (B2):

- **Rate limit** — keyed by `publishableKey + user_id`, default 60/min
  (`SDK_RATE_LIMIT_MAX`). Over the limit → `429 rate_limited`.
- **Origin allow-list** — each key carries `allowed_origins`. It is enforced
  **only when an `Origin` header is present** (browsers send one); a present but
  non-allow-listed origin → `403 origin_not_allowed`. Native SDKs send no `Origin`
  and always pass, and an empty allow-list means "no browser restriction".

### Eligibility (event-keyed)

`GET /v1/sdk/eligibility?event_name=&user_id=&context=&session_age_days=`

- `event_name` (required) is the trigger; eligibility resolves the one active
  workflow on `(account_id, event_name)`.
- `context` (optional) is free-text metadata (e.g. a screen name) for debugging —
  **never** a targeting key.
- `session_age_days` (optional) feeds the workflow's min-session-age gate.

Gate order: cooldown/suppression → session-age → **sampling**. A **not-sampled**
ask returns not-eligible and writes nothing — it does not consume the user's
cooldown (the RNG is injected so tests are deterministic). A grant returns the ask
config (`campaign_id` is retained as the wire field name for the workflow id) plus
a `trigger_id`; the response/dismiss endpoints reference that trigger.

### Endpoint map

Every `/v1/console/*` route below (i.e. all except `/auth/*`) requires the
session cookie; the session guard returns 401 without one.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/console/auth/signup` | creates account + admin + key; sets `signal_session`; 5/min/IP; `409 email_taken` on dup |
| `POST` | `/v1/console/auth/login` | sets `signal_session`; rate-limited 5/min/IP |
| `POST` | `/v1/console/auth/logout` | clears the cookie |
| `GET` | `/v1/console/auth/me` | current user or 401 |
| `GET` | `/v1/console/workflows` | list (archived excluded unless `?include=archived`) |
| `POST` | `/v1/console/workflows` | create a draft |
| `GET` | `/v1/console/workflows/:id` | full workflow or 404 |
| `PATCH` | `/v1/console/workflows/:id` | update draft (`event_name`, `sampling_rate`, `min_session_age_days`, …); semantic fields incl. `event_name` lock to `422 semantic_locked` after the first response |
| `POST` | `/v1/console/workflows/:id/publish` | draft → active; `422 incomplete` (with `missing`) / `409 overlap` (one active per account+event, with `conflict`) |
| `POST` | `/v1/console/workflows/:id/pause` | active → paused |
| `POST` | `/v1/console/workflows/:id/resume` | paused → active (re-runs the overlap check) |
| `POST` | `/v1/console/workflows/:id/archive` | any non-archived state → archived |
| `DELETE` | `/v1/console/workflows/:id` | hard-delete a draft with no history only, else `409 has_history` |
| `GET` | `/v1/console/workflows/:id/overview` | trigger/response counts, response rate, positive score |
| `GET` | `/v1/console/workflows/:id/reasons` | ranked top complaint reasons — non-null `chip_selected` counts with `share`; `total_chip_responses` + `chips[]` |
| `GET` | `/v1/console/workflows/:id/responses` | cursor-paginated response feed (`?min_rating=&max_rating=&cursor=&limit=`) |
| `GET` | `/v1/console/workflows/:id/trend` | 30-day daily positive-score series (`points[]` of `{date, responses, positive_score}`) |
| `GET` | `/v1/console/dashboard` | landing summary — KPIs, attention rules, workflow-health list |

Two behaviors worth calling out: delete is archive-first — a workflow that has ever
fired or collected a response can only be archived, never hard-deleted (M2-D6); and
`event_name` becomes immutable once the workflow has its first response (it joins
the semantic-field lock). One active workflow per `(account, event_name)` is
enforced by a partial unique index and by the publish/resume overlap check (→ 409);
at runtime, if two ever overlap, the oldest `created_at` wins.

### Reporting (per-workflow tabs)

The per-workflow reporting endpoints back the Console's Reasons / Responses / Trend
tabs. They are API-only (no dashboard aggregation), account-scoped, and, like the
rest of `/v1/console/*`, require the session cookie. An unknown workflow id (or one
owned by another account) returns `404 campaign_not_found`, and every ratio is
null-safe — a zero denominator yields `null` (never `0`).

- `GET /v1/console/workflows/:id/reasons` — the top complaint reasons: ranked,
  non-null `chip_selected` counts each with a `share`. Returns `total_chip_responses`
  and `chips[]` (`{ chip, count, share }`).
- `GET /v1/console/workflows/:id/responses?min_rating=&max_rating=&cursor=&limit=` —
  the cursor-paginated response feed, newest-first (`limit` defaults to 50, max 200),
  filterable by an inclusive score range. Each item carries `rating_value`,
  `chip_selected`, `other_text`, `other_image_url`, `location`, `device_os`,
  `app_version`, `shown_at`/`responded_at`, plus a top-level `next_cursor`.
- `GET /v1/console/workflows/:id/trend` — the 30-day daily positive-score series:
  `points[]` of `{ date, responses, positive_score }` (one point per UTC day).

The dashboard's `integration_status` field and the `target_not_live` attention rule
are inert after B2 (targets are gone): `integration_status` is always `null` and the
rule never fires.

### End-to-end demo

`scripts/demo-loop.sh` (above) is the B2 exit-proof: it signs up an account,
builds + publishes event-keyed workflows through the Console API under that account
(and proves the one-active-per-event 409), then drives the full SDK loop with the
returned publishable key — signup → build/publish → eligibility → response/dismiss
→ suppression, plus the session-age gate and free-text `context`, all
account-scoped.

## Android SDK (deferred)

The committed **Signal SDK** (`com.beatroute:signal-sdk`) is the original prototype
and is **deferred** after B2 — it still speaks the old `screen_id`/dwell trigger
contract, which the backend no longer accepts. Nothing consumes it. It will be refit
against the new `event_name` contract during the frontend phase (a shared web-core
plus native shells). See [`sdk-android/DEFERRED.md`](sdk-android/DEFERRED.md).

See [`docs/signal-spec-v1.md`](docs/signal-spec-v1.md),
[`docs/signal-architecture-v1.md`](docs/signal-architecture-v1.md), and
[`docs/plans/`](docs/plans/) for the spec, architecture, and milestone plans.
