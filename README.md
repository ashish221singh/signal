# Signal

In-app CSAT/CES feedback system for BeatRoute's field-rep app. One system, three parts, one name:

- **Signal Console** — internal admin tool for PMs to build/manage feedback campaigns (no engineering after initial setup)
- **Signal Backend** — standalone service: campaign config, eligibility, suppression, response storage, reporting
- **Signal SDK** — Android library (`com.beatroute:signal-sdk`): bottom sheet UI + trigger hooks + networking

## Source of truth

- [`docs/signal-spec-v1.md`](docs/signal-spec-v1.md) — full product & technical spec (v1.1, locked). Read this first; all build work traces back to it.
- [`docs/signal-architecture-v1.md`](docs/signal-architecture-v1.md) — system architecture (layering, hot path, idempotency).
- [`docs/plans/`](docs/plans/) — milestone implementation plans.

## Status

- **Spec:** locked (v1.1, 2026-07-08)
- **Build:** Milestone 1 (backend walking skeleton) complete — the full core loop runs against real Postgres
- Open decisions before/during build: spec §13
- Items requiring BeatRoute engineering (OAuth creds, client-list API details): spec §14.2 — use placeholder env vars (`BEATROUTE_CLIENT_ID`, `BEATROUTE_CLIENT_SECRET`, `BEATROUTE_TOKEN_URL`, `BEATROUTE_CLIENTS_API_URL`), never hardcode

## Planned layout (per spec §12 build sequence)

```
Signal/
├── docs/          specs, plans, API contracts
├── backend/       Signal Backend service (data model, /eligibility /response /dismiss, campaign CRUD, reporting, client sync)
├── sdk-android/   com.beatroute:signal-sdk (bottom sheet, hooks, networking, local suppression cache)
└── console/       Signal Console (campaign builder + reporting dashboard)
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
pnpm --filter @signal/api db:migrate && pnpm --filter @signal/api seed
pnpm --filter @signal/api dev &
./scripts/demo-loop.sh   # prints ALL SCENARIOS PASSED
```

## Console API

The Console API (Milestone 2) is the backend for the Signal Console — the internal
admin surface PMs use to build and manage campaigns. All routes live under
`/v1/console/*`. Everything except `/v1/console/auth/*` requires a valid session
cookie.

### First admin

There is no signup UI. Seed (or refresh) the first admin from the CLI:

```bash
pnpm --filter @signal/api create-admin -- \
  --email pm@signal.local --name PM --password changeme123
```

It upserts by email: re-running refreshes the password and name for an existing
user (it never changes their role). Password must be at least 10 characters.

### Auth (cookie session)

- `POST /v1/console/auth/login` `{ email, password }` → on success sets a signed,
  httpOnly cookie `signal_session` (`sameSite=strict`, `secure` in production,
  12h expiry) and returns the user. Rate-limited to **5/min/IP**.
- `POST /v1/console/auth/logout` → clears the cookie (204).
- `GET /v1/console/auth/me` → the current user, or 401.

No user enumeration: a wrong password and an unknown email both return
`401 invalid_credentials`.

### Endpoint map

Every `/v1/console/*` route below (i.e. all except `/auth/*`) requires the
session cookie; the session guard returns 401 without one.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/console/auth/login` | sets `signal_session`; rate-limited 5/min/IP |
| `POST` | `/v1/console/auth/logout` | clears the cookie |
| `GET` | `/v1/console/auth/me` | current user or 401 |
| `GET` | `/v1/console/targets` | list targets |
| `POST` | `/v1/console/targets` | create; server-side slug, `422 slug_conflict` on collision (no auto-suffix) |
| `PATCH` | `/v1/console/targets/:id/integration-status` | transition; `422 illegal_transition` off the transition table |
| `GET` | `/v1/console/clients` | list clients |
| `GET` | `/v1/console/campaigns` | list (archived excluded unless `?include=archived`) |
| `POST` | `/v1/console/campaigns` | create a draft |
| `GET` | `/v1/console/campaigns/:id` | full campaign or 404 |
| `PATCH` | `/v1/console/campaigns/:id` | update draft; semantic fields lock to `422 semantic_locked` after the first response |
| `POST` | `/v1/console/campaigns/:id/publish` | draft → active; `422 incomplete` (with `missing`) / `409 overlap` (with `conflict`) |
| `POST` | `/v1/console/campaigns/:id/pause` | active → paused |
| `POST` | `/v1/console/campaigns/:id/resume` | paused → active (re-runs the overlap check) |
| `POST` | `/v1/console/campaigns/:id/archive` | any non-archived state → archived |
| `DELETE` | `/v1/console/campaigns/:id` | hard-delete a draft with no history only, else `409 has_history` |
| `GET` | `/v1/console/campaigns/:id/overview` | trigger/response counts, response rate, positive score |
| `GET` | `/v1/console/campaigns/:id/reasons` | ranked top complaint reasons — non-null `chip_selected` counts with `share`; `total_chip_responses` + `chips[]` |
| `GET` | `/v1/console/campaigns/:id/clients` | per-client breakdown — `triggers`, `responses`, `response_rate`, `positive_score` |
| `GET` | `/v1/console/campaigns/:id/responses` | cursor-paginated response feed (`?min_rating=&max_rating=&cursor=&limit=`) |
| `GET` | `/v1/console/campaigns/:id/trend` | 30-day daily positive-score series (`points[]` of `{date, responses, positive_score}`) |
| `GET` | `/v1/console/dashboard` | landing summary — KPIs, attention rules, campaign-health list |

Two behaviors worth calling out: delete is archive-first — a campaign that has ever
fired or collected a response can only be archived, never hard-deleted (M2-D6); and
publish is **never** blocked by a target's `integration_status` (M2-D7).

### Reporting (per-campaign tabs)

The four per-campaign reporting endpoints back the Console's Reasons / Clients /
Responses / Trend tabs. They are API-only (no dashboard aggregation) and, like the
rest of `/v1/console/*`, require the session cookie. An unknown campaign id returns
`404 campaign_not_found`, and every ratio is null-safe — a zero denominator yields
`null` (never `0`).

- `GET /v1/console/campaigns/:id/reasons` — the top complaint reasons: ranked,
  non-null `chip_selected` counts each with a `share`. Returns `total_chip_responses`
  and `chips[]` (`{ chip, count, share }`).
- `GET /v1/console/campaigns/:id/clients` — per-client breakdown: `client_id`,
  `triggers`, `responses`, `response_rate`, `positive_score`.
- `GET /v1/console/campaigns/:id/responses?min_rating=&max_rating=&cursor=&limit=` —
  the cursor-paginated response feed, newest-first (`limit` defaults to 50, max 200),
  filterable by an inclusive score range. Each item carries `rating_value`,
  `chip_selected`, `other_text`, `other_image_url`, `location`, `client_id`,
  `device_os`, `app_version`, `shown_at`/`responded_at`, plus a top-level
  `next_cursor`.
- `GET /v1/console/campaigns/:id/trend` — the 30-day daily positive-score series:
  `points[]` of `{ date, responses, positive_score }` (one point per UTC day).

### Console demo

`scripts/console-demo.sh` is the Milestone 2 exit-proof. It logs in as the seeded
admin, registers a target, builds and publishes a CSAT campaign, and then shows
that same Console-built campaign firing through the Milestone 1
`/v1/sdk/eligibility` engine — proving build → publish → fire → report end to end
across M1 and M2. It also exercises the overlap `409` and pause suppression.

```bash
docker compose up -d
pnpm --filter @signal/api db:migrate && pnpm --filter @signal/api seed
pnpm --filter @signal/api create-admin -- \
  --email pm@signal.local --name PM --password changeme123
pnpm --filter @signal/api dev &
ADMIN_EMAIL=pm@signal.local ADMIN_PASSWORD=changeme123 ./scripts/console-demo.sh
# prints ALL CONSOLE SCENARIOS PASSED
```

## Client sync

The `clients` table is a read-only cache of BeatRoute's client roster, kept fresh by
a one-shot CLI:

```bash
pnpm --filter @signal/api sync-clients
```

Each run does an OAuth2 client-credentials pull from BeatRoute, then an **idempotent**
upsert into `clients`: it inserts new clients, updates the `name`/`status` of existing
ones, deactivates any client absent from the source (sets `status = inactive`), and
**never deletes** a row. Touched rows have their `last_synced_at` bumped. On any
failure (token or client-list fetch) it logs which step failed, leaves the `clients`
cache **untouched**, and exits non-zero so alerting notices.

Configuration is via `BEATROUTE_*` env placeholders:

| Var | Purpose |
| --- | --- |
| `BEATROUTE_TOKEN_URL` | OAuth2 token endpoint |
| `BEATROUTE_CLIENTS_API_URL` | client-list endpoint |
| `BEATROUTE_CLIENT_ID` | client-credentials id |
| `BEATROUTE_CLIENT_SECRET` | client-credentials secret |
| `BEATROUTE_OAUTH_SCOPE` | OAuth scope (default `clients:read`) |

In dev/test these default to a local mock (`http://localhost:4599/...`). In production
they are **required** — missing values fail fast at startup. The secret originates
from a secrets manager in prod; **never commit a real secret**.

**Asks for BeatRoute engineering** (spec §14.2):

- register a `signal-backend` client-credentials app,
- issue a client id/secret scoped `clients:read`,
- confirm the token URL and the client-list response shape:
  `[{ id | client_id, name, status }]`.

The command itself is stateless — the nightly cadence is owned by an **external
scheduler** set up in the deploy milestone, not by this repo.

## Android SDK

The **Signal SDK** (`com.beatroute:signal-sdk`) is the Android library hosts
integrate: a one-line hook at the right moment drives the full feedback loop
(eligibility → config-driven bottom sheet → response/dismiss → suppression),
invisible when there's nothing to ask and guest-safe by construction.

See [`sdk-android/README.md`](sdk-android/README.md) for the full integration +
testing guide: `SessionProvider` + `Signal.init`, the `trackEvent` /
`onScreenEnter` / `onScreenExit` hooks, behaviour notes, build/test commands
(`./gradlew :signal-sdk:testDebugUnitTest` / `assembleRelease`), pointing at a
local backend, and the manual QA checklist.

See [`docs/signal-spec-v1.md`](docs/signal-spec-v1.md),
[`docs/signal-architecture-v1.md`](docs/signal-architecture-v1.md), and
[`docs/plans/`](docs/plans/) for the spec, architecture, and milestone plans.
