# Signal

In-app CSAT/CES feedback system for BeatRoute's field-rep app. One system, three parts, one name:

- **Signal Console** — internal admin tool for PMs to build/manage feedback campaigns (no engineering after initial setup)
- **Signal Backend** — standalone service: campaign config, eligibility, suppression, response storage, reporting
- **Signal SDK** — Android library (`com.beatroute:signal-sdk`): bottom sheet UI + trigger hooks + networking

## Source of truth

- [`docs/signal-spec-v1.md`](docs/signal-spec-v1.md) — full product & technical spec (v1, locked). Read this first; all build work traces back to it.

## Status

- **Spec:** locked (v1, 2026-07-08)
- **Build:** not started
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
