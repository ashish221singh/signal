# RECONCILE: cooldown enum remodel — apply after M1, before M2 integration

> **Status:** PENDING. Do NOT start while the M1 session holds the repo.
> Apply as one dedicated changeset once M1's exit checklist is green, before any
> Console-to-backend integration. Nothing is deployed and there is no real data,
> so the database is disposable — rewrite the migration, don't ALTER TYPE.

## What changed and why

Product decision (2026-07-08): campaign cooldown options are now
`after_7_days` (default) · `after_30_days` · `after_60_days`, replacing the old
`once_per_week | once_per_day | no_cooldown`. The prototype (v4) and project
memory already reflect this; the spec and the M1 backend do not yet.

**This is a remodel, not a rename.** Mapping:

| Old | New | Note |
|---|---|---|
| `once_per_week` (168h) | `after_7_days` (168h) | exact, same value |
| `once_per_day` (24h) | — | DELETED — no 24h option anymore |
| `no_cooldown` | — | DELETED |

Two features die as a consequence:

1. **Debounce machinery (M1-D6)** — `SIGNAL_NO_COOLDOWN_DEBOUNCE_SECONDS` env var
   and the debounce path in `cooldownEndsAt`. It existed only to protect the
   double-trigger race on no-cooldown campaigns. New minimum cooldown is 7 days,
   so the atomic claim's `next_eligible_at` is always ≥7 days out and the race is
   protected for free. Delete the env var, its parse test, and the debounce param.

2. **`daily_cap` (M1-D7)** — confirmed removed from the prototype's Rules step
   (only 7/30/60 + min-tenure remain). With a 7-day minimum, a per-24h cap can
   never trigger. Remove the `daily_cap` column, its count query in the
   eligibility service, and its tests. (Min-tenure gate STAYS.)

## Files to change (all in the finished M1 tree)

- `packages/contracts/src/primitives.ts` — `askFrequencySchema` enum values.
- `apps/api/src/db/schema.ts` — `askFrequencyEnum` values; DROP `dailyCap` column.
  Regenerate the migration (delete the old generated SQL; DB is disposable).
- `apps/api/src/eligibility/cooldown.ts` — `cooldownEndsAt` becomes a pure
  `enum → days` map: 7 / 30 / 60. Drop the `noCooldownDebounceSeconds` param.
- `apps/api/src/eligibility/cooldown.test.ts` — rewrite the three cases; delete
  the no_cooldown/debounce case.
- `apps/api/src/eligibility/decide.ts` + `service.ts` — remove `dailyCap` /
  `showsInLast24h` logic and the trigger_log count query; remove the
  `daily_cap` branch and its `decide` test.
- `apps/api/src/feedback/dismiss.ts` — drop the debounce opt from the cooldown call.
- `apps/api/src/env.ts` + `env.test.ts` — delete `SIGNAL_NO_COOLDOWN_DEBOUNCE_SECONDS`.
- `apps/api/src/app.ts`, `routes/sdk.ts` — remove the debounce wiring.
- `apps/api/src/scripts/seed-dev.ts` — reword campaigns: use `after_7_days` etc.;
  drop the daily-cap demo campaign (replace with a 30-day or 60-day campaign).
- `scripts/demo-loop.sh` — delete the daily-cap scenario; the race scenario stays
  (now protected by the 7-day cooldown, no `SIGNAL_NO_COOLDOWN_DEBOUNCE_SECONDS=2`
  needed). Adjust the cooldown-expiry scenario to advance past 7 days.
- `docs/signal-spec-v1.md` → v1.2: §6 (ask_frequency values + drop daily_cap),
  §7.2 Campaign model (enum + remove daily_cap field), §8.3 dismiss cooldown note.
- `docs/signal-architecture-v1.md` — any cooldown mentions.

## Exit proof after reconciliation

`pnpm verify` green; `./scripts/demo-loop.sh` prints ALL SCENARIOS PASSED with the
new enum; grep confirms no remaining `once_per_week|once_per_day|no_cooldown|
daily_cap|DEBOUNCE` in `apps/` or `packages/`.
