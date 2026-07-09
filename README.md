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
SIGNAL_NO_COOLDOWN_DEBOUNCE_SECONDS=2 pnpm --filter @signal/api dev &
./scripts/demo-loop.sh   # prints ALL SCENARIOS PASSED
```

See [`docs/signal-spec-v1.md`](docs/signal-spec-v1.md),
[`docs/signal-architecture-v1.md`](docs/signal-architecture-v1.md), and
[`docs/plans/`](docs/plans/) for the spec, architecture, and milestone plans.
