# B5 — Post-Submit Actions Config Extension Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the workflow config so a workflow can express **branchable post-submit actions** — a positive action and a negative action, each one of `none | thanks | redirect | store_review` — set entirely by the agent (MCP / config-as-code). This is the last backend piece before the bottom sheet; it gives the sheet real actions to render. Small, additive, on `main` (backend B1–B4 merged).

**Architecture:** Unchanged layering. Replace the BeatRoute-flavored `on_positive_action` enum on `workflows` with two validated JSON action configs. The eligibility config response carries the resolved actions so the sheet renders them; the MCP tool + deploy payload + contracts expose them in plain terms (`onPositive`/`onNegative`) so an agent maps natural language cleanly. **First incremental migration (`0001`)** — migrations were frozen at end of B4.

**Tech Stack:** unchanged. No new dependencies.

**Prerequisites:** backend B1–B4 merged to `main` and green. Node 22 + Docker (see the B-series env notes).

---

## Decisions & Edge Cases (binding)

| # | Decision | Rationale / edge case |
|---|---|---|
| B5-D1 | Replace `on_positive_action` with two `jsonb` columns: `positive_action` and `negative_action`, each `{ type: 'none'\|'thanks'\|'redirect'\|'store_review', message?: string, url?: string }`. | Branch-by-score needs two independent actions; jsonb + a Zod shape is the least-ceremony way to carry a small tagged union. |
| B5-D2 | Validation (Zod + service): `redirect` ⇒ `url` required and must be `https://…`; `thanks` ⇒ optional `message` (a sensible default is applied if absent); `store_review`/`none` ⇒ no extra fields. Enforced at the contract boundary and re-checked at publish. | Structurally invalid actions must be impossible on an active workflow; url safety (https-only) blocks open-redirect-ish misuse. |
| B5-D3 | The **SDK eligibility config** response gains `positive_action` + `negative_action` (resolved). | The sheet is pure-render; it needs the actions inline in the config it already receives. |
| B5-D4 | MCP `create_workflow`/`update_workflow` and the config-as-code `deploy` payload expose `onPositive` / `onNegative` with the same shape, documented in plain language. | The agent is the only author; the field names/shape must read naturally from a NL description. |
| B5-D5 | This is the **first incremental migration `0001`** (no more `0000` rewrites). Backfill: existing rows map `play_store_review → {type:'store_review'}` positive / `none` negative; `none → {type:'none'}` both. | Post-freeze discipline; the seed data and any dev rows migrate cleanly. |
| B5-D6 | Keep `chips_on_negative` in the schema (unused by the v1 sheet). Do **not** remove it. | Chips are dropped from the v1 sheet only; keeping the column avoids a needless destructive change and preserves the option later. |

---

## Tasks

### Task 1 — Schema + migration (B5-D1,D5)
Add `positive_action jsonb` + `negative_action jsonb` to `workflows`; drop `on_positive_action`; write incremental migration `0001` with the B5-D5 backfill. Amend the active-complete CHECK if it referenced `on_positive_action`. **Verify:** `schema.int.test.ts` — columns present; migration applies on a DB seeded with old-shape rows and backfills correctly.

### Task 2 — Contracts (B5-D2,D3,D4)
Add an `action` Zod schema (tagged union with the https-url refinement); add `positiveAction`/`negativeAction` to the workflow create/update, the deploy payload item, and the SDK eligibility config. Provide the default thank-you message constant. **Verify:** contract unit tests — redirect-without-url rejected; https enforced; defaults applied.

### Task 3 — Service + publish validation (B5-D2)
Thread the actions through the workflow service; re-validate at publish (completeness now includes well-formed actions). **Verify:** `console-workflows.int.test.ts` — publish rejects a redirect action missing a url (422); accepts valid branched actions.

### Task 4 — Eligibility config (B5-D3)
Include resolved `positive_action`/`negative_action` in the `/v1/sdk/eligibility` config payload. **Verify:** `eligibility.int.test.ts` — config carries the actions.

### Task 5 — MCP + deploy surface (B5-D4)
Expose `onPositive`/`onNegative` in the MCP `create_workflow`/`update_workflow` tool schemas and the `deploy` payload; update `docs/cli-mcp-deploy.md` with a NL→config example. **Verify:** MCP round-trip sets actions; `deploy.int.test.ts` upserts them.

### Task 6 — Seed/demo + verify
Update `seed-dev.ts` sample workflows to use branched actions (e.g. positive `thanks`, negative `redirect`); refresh demos. `pnpm verify` + both demos green. **Verify:** demos pass; clean tree.

---

## Edge cases & failure modes

**Action validation**
- `redirect` with no `url`, or a non-`https` url (`http://`, `javascript:`, `data:`, `file:`, relative) → **rejected 422** at contract and publish.
- `redirect` url that is syntactically valid but hostile (open-redirect to phishing) → out of scope to police (the customer sets their own destination); we only enforce `https` + well-formed. Length cap the url (e.g. 2048).
- `thanks` with an over-long or HTML/script-bearing `message` → length-capped (e.g. 280 chars) and treated as **plain text** by the sheet (F1 never renders it as HTML). Empty message → the default constant is applied.
- `store_review`/`none` sent WITH `message`/`url` → extra fields stripped (not an error) so agents can be sloppy.
- Unknown `type` value → 422 (closed enum).
- Both actions `none` → valid (a rating-only workflow that just closes).

**Branching & runtime**
- Rating exactly at `positive_threshold` → **positive** (`>=`), so the positive action fires.
- User **dismisses** (never submits) → **no action fires** (actions are post-*submit* only).
- Action resolution happens **after** the response is recorded/queued, so a `redirect` navigation can never lose the answer.
- `store_review` on a surface with no store (web, hosted link) → the host **falls back** (F1: treat as `thanks`/close); B5 just carries the intent, the shell decides. Documented so agents aren't surprised web ignores it.

**Migration/backfill**
- Old rows: `play_store_review` → `positive={type:'store_review'}`, `negative={type:'none'}`; `none` → both `{type:'none'}`. Seeded/dev rows migrate; a re-run of `0001` is a no-op (idempotent guard).
- Rollback: since it's the first incremental migration, keep a `down` that restores the enum (dev-only safety).

**Agent authoring (MCP/deploy)**
- NL like "thank them / send unhappy users to support" → `positive:{type:'thanks'}`, `negative:{type:'redirect',url:…}`. If the agent omits a url on a redirect, the tool returns a clear validation error the agent can self-correct from (surface the 422 message verbatim).
- `deploy` upserting an action-only change (no other fields) → still idempotent; unchanged action = no-op.

## Exit checklist
- [ ] `workflows` has `positive_action`/`negative_action`; `on_positive_action` gone; migration `0001` applies + backfills.
- [ ] Actions validated (redirect⇒https url; thanks default) at contract + publish.
- [ ] Eligibility config carries both actions; MCP + deploy expose `onPositive`/`onNegative`.
- [ ] `pnpm verify` + both demos green; migrations remain incremental.

## Hand-off to F1
Workflows now carry branchable post-submit actions in their config. **F1** builds the bottom sheet that renders this config (emoji rating → branch → comment/photo → submit → the resolved action).
