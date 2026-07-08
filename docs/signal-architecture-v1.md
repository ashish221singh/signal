# Signal — Technical Architecture

### System Design — v1 (companion to `signal-spec-v1.md`)

Validated 2026-07-08 through collaborative design review. This doc records **how** Signal is built; the spec records **what** it does. Where the two overlap, the spec wins on behavior and this doc wins on implementation.

---

## 0. Constraints That Shaped Every Decision

| Constraint | Consequence |
|---|---|
| Standalone tool; touches BeatRoute only via APIs | Free choice of infra; must stay portable (containerized) |
| Hundreds of active reps (~10–50k eligibility calls/day at full rollout) | One service + one Postgres is comfortably sufficient; no distributed machinery in v1 |
| Owned and maintained by product owner + Claude Code | One coherent, strongly-typed stack over "what a team already knows" |
| Non-negotiables: scalable + user-friendly | "Scalable" = scales by adding instances/config, never by rewrite. "User-friendly" = rep flow never degraded; PM console self-serve |

**Load profile analysis** — Signal is three workloads under one name:

1. **Hot path** — `GET /eligibility`: fires on every instrumented action, latency-sensitive (rep mid-flow on 4G), must fail silent. Dictates DB/caching design.
2. **Warm path** — `/response`, `/dismiss`, image uploads: write-heavy but low volume (only after a sheet was shown), tolerant of latency.
3. **Cold path** — Console CRUD, reporting aggregation, nightly client sync: a handful of internal PM users.

---

## 1. Stack Decision

**Chosen: full-TypeScript monorepo** (Option A of three considered).

- **Backend:** Node.js + Fastify + PostgreSQL (Drizzle ORM)
- **Console:** React SPA (Vite)
- **Shared contracts:** Zod schemas — spec §8 as executable code
- **SDK:** Kotlin (fixed by platform)

**Why A over the alternatives:** the API contract is the load-bearing artifact of the whole system (spec §12 locks it first). A shared Zod contracts package makes that contract *compiler-enforced* across backend and console rather than discipline-enforced. One language, one test runner, one deploy pipeline — the most productive shape for AI-assisted solo maintenance.

Rejected:
- **B — Python FastAPI + React:** two languages; contract lives in two places synced by codegen, which can drift.
- **C — Single Next.js app:** couples the rep-facing hot path to console release cycles; background jobs awkward in serverless-style routes.

---

## 2. System Topology

```
                        ┌─────────────────────────────────────┐
                        │           SIGNAL BACKEND            │
 ┌──────────────┐       │  ┌───────────────────────────────┐  │
 │  Route App   │ HTTPS │  │   API service (Node/Fastify)  │  │
 │  (Android)   │──────▶│  │  /v1/sdk/eligibility          │  │
 │ ┌──────────┐ │       │  │  /v1/sdk/response  /dismiss   │  │
 │ │signal-sdk│ │       │  ├───────────────────────────────┤  │
 │ └──────────┘ │       │  │  /v1/console/* (same process) │  │
 └──────────────┘       │  │  campaigns, reporting, clients│  │
                        │  └──────┬──────────────┬─────────┘  │
 ┌──────────────┐       │         ▼              ▼            │
 │Signal Console│──────▶│    PostgreSQL     Object storage    │
 │ (React SPA)  │ HTTPS │         ▲          (images, R2)     │
 └──────────────┘       │  ┌──────┴────────┐                  │
                        │  │Sync job (cron)│──▶ BeatRoute     │
                        │  └───────────────┘    client API    │
                        └─────────────────────────────────────┘
```

**One deployable service, two logical API surfaces.** SDK-facing and Console-facing endpoints share one Fastify process under separate route prefixes (`/v1/sdk/*`, `/v1/console/*`) with separate auth (SDK: signed app token; Console: PM login JWT). Cleanly separated at module level, so splitting into two services later is a deploy change, not a rewrite.

**Monorepo layout (pnpm workspaces):**

```
signal/
├── apps/
│   ├── api/            # Fastify service + sync job
│   └── console/        # React SPA (Vite)
├── packages/
│   └── contracts/      # Zod schemas = spec §8 as code
├── sdk-android/        # Kotlin library (own Gradle build; AAR published from CI)
└── docker-compose.yml  # local dev: Postgres + MinIO (S3-compatible)
```

The Kotlin SDK living in-repo doesn't block the spec §13 option of publishing to an internal Maven repo later — CI publishes the artifact from here.

---

## 3. Backend Internals

**Layering:** routes → services → repositories. Zod validation from `contracts` at the boundary. Fastify chosen for speed, minimalism, and first-class schema validation — no framework magic.

### 3.1 The eligibility hot path

```
GET /v1/sdk/eligibility?screen_id&user_id&client_id&rep_tenure_days
  1. Active campaign for (screen_id, client_id)   ← in-memory cache
  2. SuppressionState (user_id, campaign_id)      ← one indexed PG read (PK lookup)
  3. min_tenure_days check                        ← request context
  4. Eligible → INSERT TriggerLog + UPSERT SuppressionState, return config (incl. trigger_id)
     Not eligible → 204 empty
```

**Decision — in-process campaign cache, no Redis.** Active campaigns are dozens of rows, changing only on PM edits. Held in memory, refreshed every 60s. The hot path costs one indexed read plus one write when eligible. Redis at this scale is an extra failure mode, not a speedup. The design survives multi-instance scaling (60s staleness on campaign edits is harmless).

**Decision — suppression written at show-time, not submit-time.** Returning an eligible config immediately records `last_shown_at` and provisionally sets `next_eligible_at` per cooldown; `/response` and `/dismiss` then update the row. A rep who kills the app mid-sheet is not re-prompted instantly — safest failure default.

**Latency budget:** p99 < 150ms server-side. The SDK enforces its own 2s timeout — if Signal is slow or down, the sheet never appears. Signal must never make the Route app worse.

**Idempotency:** `/response` and `/dismiss` are idempotent, keyed on trigger_id (unique constraint on responses.trigger_id), because the SDK's offline outbox retries them (§6.1).

---

## 4. Database — PostgreSQL

**ORM: Drizzle** — TypeScript-native, generates readable plain-SQL migrations, no runtime magic.

Tables map one-to-one to spec §7: `target_registry`, `campaigns`, `suppression_state`, `trigger_log`, `responses`, `clients` (synced cache).

**Hot-path indexes:**
- `suppression_state` composite **PK `(user_id, campaign_id)`** — eligibility step 2 is a single PK lookup
- `campaigns (status, target_id)` — feeds the in-memory cache refresh
- `responses (campaign_id, responded_at)` — carries all reporting queries

**Reporting = plain SQL.** At this scale a year of responses is ~100–200k rows; the 30-day trend, chip ranking, and client breakdown are each one `GROUP BY`. No warehouse, no materialized views in v1 — revisit only if query times actually degrade.

**Deliberate denormalization:** `responses` snapshots `screen_id`, `rep_tenure_days`, `app_version` at answer time rather than joining live data — reporting must reflect what was true when the rep answered, even if campaign/rep data changes later.

---

## 5. Signal Console (React SPA)

**Vite + React, static bundle** — internal login-gated tool: no SEO, no SSR need. Served from CDN or by the API service itself.

| Layer | Choice | Why |
|---|---|---|
| Data fetching | TanStack Query | Loading/error/cache/refetch solved once |
| Routing | TanStack Router | Type-safe routes; broken links are compile errors |
| UI | shadcn/ui + Tailwind | Owned-as-source primitives; matches the code-first design-system philosophy; can adopt BeatRoute design tokens later |
| Forms | React Hook Form + shared Zod contracts | Campaign builder validates against the same schema the API enforces — cannot drift |
| Charts | Recharts | Covers trend line, bar comparison, chip ranking without a heavyweight platform |

**Surfaces:**
1. **Campaign builder** — stepper: client picker → target picker → trigger config → content config → publish, with a **live preview of the bottom sheet rendered from the config** so PMs see exactly what reps will see. Includes the §9.4 snippet generator for `not_sent` targets.
2. **Reporting** — the four §10 views: per-activity dashboard, chip ranking, client breakdown, drill-down feed.

**Auth:** email/password + short-lived JWTs for the handful of internal PMs. Auth module isolated so Google Workspace SSO later is a one-file swap.

---

## 6. Signal SDK (Android / Kotlin)

Prime directive: **invisible when it has nothing to say; never degrade the host app.**

```
Signal (object)  ← only public API: init / trackEvent / onScreenEnter / onScreenExit
   ├── EligibilityClient       OkHttp, 2s timeout, fails silent
   ├── LocalSuppressionCache   DataStore — known-suppressed campaigns short-circuit
   │                           before any network call (saves 4G round-trips)
   ├── DwellTimer              coroutine started onScreenEnter, cancelled onScreenExit
   ├── SignalBottomSheetFragment  one fragment, 4 view states (spec §5),
   │                           rendered entirely from config JSON
   └── OutboxQueue             Room + WorkManager — /response and /dismiss queued
                               locally, flushed with retry on reconnect
```

### 6.1 The fire-and-forget / precious asymmetry
- **Eligibility checks are fire-and-forget:** network failure → show nothing, lose nothing.
- **Responses are precious:** a rep spent effort answering, so `/response` and `/dismiss` go through a persistent outbox retried on reconnect. Backend idempotency (§3.1) means retries never double-count.

### 6.2 Dependency discipline
Plain Kotlin + coroutines, OkHttp, Room, Material bottom sheet. No Compose requirement, no DI framework, minimal transitive baggage — an SDK is a guest in someone else's process and must not version-conflict with the Route app.

### 6.3 Images
Uploaded directly from the SDK to a **pre-signed URL** fetched from the backend; the image never travels inside the `/response` payload.

`Signal.init()` takes an environment flag (staging/production) so debug builds of the Route app hit staging.

---

## 7. Infrastructure & Operations

**Everything ships as one Docker image** (API + sync job), deployed on a managed container platform — **Fly.io, Railway, or Render; decided at deploy time.** All three provide the four things the design needs: container hosting, managed Postgres, cron, secret store. Fly.io preferred if proximity matters — its Mumbai region puts the API physically closer to India-based reps (helps the 4G latency budget), at the cost of being more CLI-driven operationally. Estimated $20–40/month at v1 scale. Migration to AWS/GCP later is repointing a pipeline, not a rebuild.

- **Environments:** `staging` + `production`, separate databases.
- **Client sync:** platform cron → protected `/internal/sync-clients` endpoint nightly, running the spec §7.6 OAuth2 flow. Placeholder env vars (`BEATROUTE_CLIENT_ID`, `BEATROUTE_CLIENT_SECRET`, `BEATROUTE_TOKEN_URL`, `BEATROUTE_CLIENTS_API_URL`) until real credentials are issued — never hardcoded.
- **Image storage:** Cloudflare R2 (S3-compatible, zero egress fees). Backend issues pre-signed upload URLs. Lifecycle/retention rule pending the §13 open item.
- **Secrets:** platform secret store — satisfies spec §7.6 without running our own secrets manager.
- **CI/CD:** GitHub Actions — typecheck + tests + migration dry-run per PR; `main` auto-deploys to staging; tagged release deploys production; SDK AAR built and published from the same pipeline.
- **Observability (proportionate to v1):** structured JSON logs (pino), Sentry on API + Console, uptime ping on `/health`, and one alert that matters: **client sync failed** (same-day alert per spec §7.6; cache left untouched).

**Fail-open posture end to end:** any component down → reps see no sheet, Route app untouched. Failure cost is lost feedback, never lost orders.

---

## 8. Testing Strategy

Weighted by what breaks the product. The two must-never-be-wrong behaviors: **eligibility logic** (false triggers are the exact bug the spec exists to avoid) and **suppression math** (re-asking a rep who said no destroys trust).

- **Unit (Vitest):** every branch of eligibility + cooldown — tenure gates, daily caps, each `ask_frequency`, dismissed/submitted transitions, timezone edges around "once per day."
- **Integration (Testcontainers):** real Fastify app against real Postgres, full loop: eligibility → trigger log → response → suppression updated → re-ask → 204.
- **Contract tests come free:** backend and console compile against `packages/contracts`; the SDK's JSON parsing is tested against fixture files generated from those same Zod schemas — three codebases, one source of truth.
- **SDK (JUnit + Robolectric):** dwell-timer cancellation, outbox retry/idempotency, each bottom-sheet state rendered from config fixtures.
- **Console (light):** component tests on campaign-builder validation; one Playwright happy path (create → publish → visible in reporting).

---

## 9. Build Order

Spec §14.5 stands, with one refinement — the contracts package comes first because it *is* the API agreement of spec §12 step 1:

1. `packages/contracts` — Zod schemas for all §8 request/response shapes
2. Data model + Drizzle migrations (§7)
3. `/eligibility`, `/response`, `/dismiss` with unit + integration tests
4. OAuth2 + client-sync job (placeholder env vars, mocked in tests)
5. SDK module (bottom sheet states, hooks, networking, outbox) — testable against mocked eligibility fixtures before backend is live
6. Console (campaign builder + reporting) once core APIs are stable
7. Wire together; swap placeholder env vars for real credentials; run spec §14.3 manual integration tests

---

## Appendix: Decision Log

| # | Decision | Rationale |
|---|---|---|
| 1 | Full-TypeScript monorepo | Compiler-enforced API contract; one stack for solo/AI maintenance |
| 2 | One service, two route surfaces | No microservice overhead at this scale; split-later is a deploy change |
| 3 | In-memory campaign cache, no Redis | Dozens of rows; Redis = added failure mode, no speedup |
| 4 | Suppression written at show-time | Crashed app can't cause re-prompt spam |
| 5 | Drizzle ORM | Readable SQL migrations, TS-native, no runtime magic |
| 6 | Plain-SQL reporting, no warehouse | ~100–200k rows/year; Postgres aggregates in ms |
| 7 | Vite SPA console, not Next.js | Internal tool; no SSR/SEO need; simplest deploy |
| 8 | Email/JWT auth for console v1 | Handful of PMs; SSO is a later one-file swap |
| 9 | SDK outbox for responses, fire-and-forget for eligibility | Responses are precious; eligibility is disposable |
| 10 | Minimal SDK dependencies, no Compose/DI | SDK is a guest in the host app's process |
| 11 | Fly.io / Railway / Render, chosen at deploy | Design needs only container + Postgres + cron + secrets; Fly's Mumbai region is a plus |
| 12 | Cloudflare R2 for images | S3-compatible, zero egress fees |
