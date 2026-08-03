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
- **Build:** B1 (Accounts & Tenancy Core) complete — the backend is now **multi-account**:
  anyone can sign up and gets an Account with its own publishable API key; every row is
  owned by an `account_id` and every query is filtered by it. All BeatRoute-specific
  machinery (the `clients` table, OAuth client-sync) has been removed. The proven core
  loop (eligibility → response → dismiss → suppression) keeps working, now account-scoped.
- **Not yet:** event re-key (B2), the agentic surface (B3), and reporting/CORS/deploy
  hardening (B4). No web UI yet (frontend phase).

## Planned layout (per spec §12 build sequence)

```
Signal/
├── docs/          specs, plans, API contracts
├── apps/api/      Signal Backend service — accounts, publishable keys, /eligibility /response /dismiss, campaign CRUD, reporting
├── packages/contracts/  shared Zod API schemas
├── sdk-android/   com.beatroute:signal-sdk (bottom sheet, hooks, networking, local suppression cache)
└── console/       Signal Console (campaign builder + reporting dashboard — frontend phase)
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
publishable key, builds + publishes campaigns under that account through the
Console API, then drives the full SDK loop with that key — no pre-seed needed.

## Console API

The Console API (Milestone 2) is the backend for the Signal Console — the internal
admin surface PMs use to build and manage campaigns. All routes live under
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

### SDK auth (publishable key)

`/v1/sdk/*` authenticates by the account's publishable key in the
`X-Signal-App-Key` header (unknown/revoked → 401). The key resolves to an
`account_id` (cached 60s) and every SDK query — eligibility, response, dismiss —
is scoped to that account.

### Endpoint map

Every `/v1/console/*` route below (i.e. all except `/auth/*`) requires the
session cookie; the session guard returns 401 without one.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/console/auth/signup` | creates account + admin + key; sets `signal_session`; 5/min/IP; `409 email_taken` on dup |
| `POST` | `/v1/console/auth/login` | sets `signal_session`; rate-limited 5/min/IP |
| `POST` | `/v1/console/auth/logout` | clears the cookie |
| `GET` | `/v1/console/auth/me` | current user or 401 |
| `GET` | `/v1/console/targets` | list the account's targets |
| `POST` | `/v1/console/targets` | create; server-side slug, `422 slug_conflict` on collision (per account, no auto-suffix) |
| `PATCH` | `/v1/console/targets/:id/integration-status` | transition; `422 illegal_transition` off the transition table |
| `GET` | `/v1/console/campaigns` | list (archived excluded unless `?include=archived`) |
| `POST` | `/v1/console/campaigns` | create a draft |
| `GET` | `/v1/console/campaigns/:id` | full campaign or 404 |
| `PATCH` | `/v1/console/campaigns/:id` | update draft; semantic fields lock to `422 semantic_locked` after the first response |
| `POST` | `/v1/console/campaigns/:id/publish` | draft → active; `422 incomplete` (with `missing`) / `409 overlap` (one active per account+target, with `conflict`) |
| `POST` | `/v1/console/campaigns/:id/pause` | active → paused |
| `POST` | `/v1/console/campaigns/:id/resume` | paused → active (re-runs the overlap check) |
| `POST` | `/v1/console/campaigns/:id/archive` | any non-archived state → archived |
| `DELETE` | `/v1/console/campaigns/:id` | hard-delete a draft with no history only, else `409 has_history` |
| `GET` | `/v1/console/campaigns/:id/overview` | trigger/response counts, response rate, positive score |
| `GET` | `/v1/console/campaigns/:id/reasons` | ranked top complaint reasons — non-null `chip_selected` counts with `share`; `total_chip_responses` + `chips[]` |
| `GET` | `/v1/console/campaigns/:id/responses` | cursor-paginated response feed (`?min_rating=&max_rating=&cursor=&limit=`) |
| `GET` | `/v1/console/campaigns/:id/trend` | 30-day daily positive-score series (`points[]` of `{date, responses, positive_score}`) |
| `GET` | `/v1/console/dashboard` | landing summary — KPIs, attention rules, campaign-health list |

Two behaviors worth calling out: delete is archive-first — a campaign that has ever
fired or collected a response can only be archived, never hard-deleted (M2-D6); and
publish is **never** blocked by a target's `integration_status` (M2-D7).

### Reporting (per-campaign tabs)

The per-campaign reporting endpoints back the Console's Reasons / Responses / Trend
tabs. They are API-only (no dashboard aggregation), account-scoped, and, like the
rest of `/v1/console/*`, require the session cookie. An unknown campaign id (or one
owned by another account) returns `404 campaign_not_found`, and every ratio is
null-safe — a zero denominator yields `null` (never `0`).

- `GET /v1/console/campaigns/:id/reasons` — the top complaint reasons: ranked,
  non-null `chip_selected` counts each with a `share`. Returns `total_chip_responses`
  and `chips[]` (`{ chip, count, share }`).
- `GET /v1/console/campaigns/:id/responses?min_rating=&max_rating=&cursor=&limit=` —
  the cursor-paginated response feed, newest-first (`limit` defaults to 50, max 200),
  filterable by an inclusive score range. Each item carries `rating_value`,
  `chip_selected`, `other_text`, `other_image_url`, `location`, `device_os`,
  `app_version`, `shown_at`/`responded_at`, plus a top-level `next_cursor`.
- `GET /v1/console/campaigns/:id/trend` — the 30-day daily positive-score series:
  `points[]` of `{ date, responses, positive_score }` (one point per UTC day).

The per-client breakdown tab was removed with the `clients` table (B1-D6).

### End-to-end demo

`scripts/demo-loop.sh` (above) is the B1 exit-proof: it signs up an account,
builds + publishes campaigns through the Console API under that account, and drives
the full SDK loop with the returned publishable key — proving signup →
build/publish → eligibility → response/dismiss → suppression end to end, all
account-scoped.

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
