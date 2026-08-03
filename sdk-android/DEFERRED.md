# Android SDK — DEFERRED (refit pending)

> **Status: deferred as of B2 (2026-08-03).** The code in `sdk-android/` is the
> original BeatRoute prototype SDK and is **not maintained against the current
> backend contract**. Nothing in the live system consumes it.

## Why it's deferred

B2 (Event Re-key) replaced the screen/client trigger model with a generic,
event-keyed one:

- eligibility is now keyed on **`event_name`** (e.g. `signal.track("checkout_completed")`),
  not `screen_id` + dwell/action triggers;
- the eligibility request contract is `{ event_name, user_id, context?, session_age_days? }`
  — `screen_id`, `client_id` and `rep_tenure_days` are gone (see
  `packages/contracts/src/eligibility.ts`);
- feedback carries `event_name`/`context` and `session_age_days`.

The committed `sdk-android/` still sends the old `screen_id` + dwell/action shape,
so it **cannot** talk to the current API. Rather than partially patch a prototype
that is itself being replaced, it stays frozen.

## The plan (frontend phase)

The SDK is **refit against the new event contract** during the frontend phase, as
part of the web-core + native-shell rework:

- a shared **web-core** implements the eligibility → config-driven sheet →
  response/dismiss → local-suppression loop against the `event_name` contract;
- thin **native shells** (Android, later iOS) wrap it and expose
  `signal.track("<event_name>", { context?, sessionAgeDays? })`.

Until then, treat everything under `sdk-android/` as reference-only. Do not build,
publish, or wire it into CI — the root `pnpm verify` intentionally does not cover
it.

## See also

- `docs/plans/2026-08-03-B2-event-rekey.md` — the event re-key plan.
- `docs/plans/2026-08-03-B1-B4-review.md` — cross-review (GR-6 marks this deferral).
- `packages/contracts/src/eligibility.ts` — the current ingest contract.
