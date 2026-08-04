# F1 — Central Bottom Sheet (web-core) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the **one** framework-agnostic renderer of the feedback bottom sheet — the flagship frontend component. It renders a workflow config (emoji rating → branch → positive action / negative comment+photo → submit → post-submit action) as a polished, accessible, animated sheet, and is reused everywhere: web SDK, native WebView shells, and the hosted preview link. **Pure render + state machine — it never touches the network.**

**Architecture:** A new no-framework TypeScript package `packages/web-core` (`@signal/web-core`). It renders into a **Shadow DOM** root (style isolation from any host page) and is driven by (1) a `WorkflowConfig` JSON (the B5 eligibility config shape) and (2) a **host interface** it calls for anything impure — `submit(answer)`, `dismiss(reason)`, `requestUpload(file) → url`, `openReview()`, `openUrl(url)`. The host (web SDK / native shell, built in F2) supplies networking, the offline outbox, suppression, and presigned uploads. Styling is `tokens.css` inlined into the shadow root. Motion, dark mode, keyboard, and screen-reader support are first-class.

**Tech Stack:** TypeScript, `tsup` (or Vite lib mode) for a small ESM+IIFE bundle, `@signal/contracts` for the config types, Vitest + `happy-dom`/`jsdom` for state-machine + DOM tests, Playwright (optional) for a visual smoke. No UI framework in the core.

**Prerequisites:** **B5 merged** (config carries `positive_action`/`negative_action`). Design system committed at `design/final-version/tokens.css`. Node 22.

---

## Decisions & Edge Cases (binding)

| # | Decision | Rationale / edge case |
|---|---|---|
| F1-D1 | **No UI framework in the core** — plain TS + DOM templating. | The sheet is a guest in arbitrary host apps (React/Angular/native WebView); a framework would bloat the bundle and risk clashes. |
| F1-D2 | Render inside a **Shadow DOM** root with `tokens.css` inlined; the same code runs in a native WebView. | Total style isolation from the host page; identical rendering across web and native. |
| F1-D3 | **Transport-agnostic core.** The core never calls `fetch`. It invokes a `SheetHost` interface: `submit`, `dismiss`, `requestUpload`, `openReview`, `openUrl`, `onResize`. | Keeps the core pure and 100% unit-testable; the same core is reused by every shell, which own I/O + outbox + presign. |
| F1-D4 | **State machine:** `rating → (positive → positiveAction) \| (negative → detail(comment+photo) → submitting → done)`; `dismiss` reachable from every state. Positive with `type:none/thanks` submits immediately then shows the thanks/close; `redirect`/`store_review` call the host after recording. | Deterministic, testable; matches the v1 flow. Recording the response happens before any redirect so data is never lost to a navigation. |
| F1-D5 | **Emoji rating only** in v1 (3-point 😞😐😊), `positive_threshold` decides the branch. The rating component takes a `scale`/`type` prop so `star`/`effort` slot in later without touching the state machine. | Matches the locked v1 scope; leaves a clean seam for more rating types. |
| F1-D6 | **No chips.** The negative branch is a single `detail` step: optional comment (`other_requires_text` ⇒ required) + optional photo (`other_allows_image`). | Chips were dropped for v1; the negative branch is comment + photo only. |
| F1-D7 | **Photo via host.** On attach, the core calls `host.requestUpload(file)` and receives back a URL (the host does the presigned upload); the core just shows a thumbnail + the returned URL goes in `submit`. Client-side guardrails: type (jpg/png/webp), max dimension downscale, size cap. | Keeps presign/networking out of the core; matches the B4 account-scoped upload flow. |
| F1-D8 | **Motion** from tokens: sheet enter/exit `motion-sheet` + `ease-sheet`; branch transitions `motion-base` + `ease-out`. Honours `prefers-reduced-motion` (instant). | Smooth/futuristic per the brand; accessible. |
| F1-D9 | **Accessibility:** focus trap, `role="dialog"` + `aria-modal`, labelled controls, full keyboard operation (Esc dismisses, arrows pick rating), live-region for submit result; honours `prefers-color-scheme`. | The sheet must not degrade the host app's accessibility. |
| F1-D10 | **Versioned config↔renderer contract**; the core declares the min config version it supports and degrades gracefully on unknown fields. | Old bundled shells must keep rendering newer configs (forward-compat). |
| F1-D11 | **Custom SVG emoji, not system emoji.** The 😞😐😊 rating uses bundled inline SVG faces (mono/brand style), never the platform emoji font. | System emoji render differently per OS/version and can't be themed/animated consistently — the mark must look identical everywhere. |
| F1-D12 | **Negative branch with no capture configured** (`other_requires_text=false` AND `other_allows_image=false`) → the detail step is **skipped**; the rating alone submits. | A negative rating with nothing to collect shouldn't show an empty step. |
| F1-D13 | **One sheet at a time.** `mount` while a sheet is already open is a **no-op** (returns the existing handle); the state machine is single-instance. | Re-entrant triggers must not stack sheets over each other. |
| F1-D14 | **Fonts bundled/degrade gracefully.** JetBrains Mono + Inter are bundled or `font-display:swap` with a system fallback stack; the sheet never blocks on font load. | No FOIT / invisible text in a guest context; layout must not jump. |
| F1-D15 | **Bundler = `tsup`.** Outputs: ESM (`dist/web-core.mjs`), an IIFE global `SignalWebCore` (`dist/web-core.global.js`), and `.d.ts`. Target ES2020, zero runtime deps, **no CSS file** — `tokens.css` is imported as a string and injected into the shadow root. Bundle budget **≤ 35 KB gzip** (excluding font files), asserted in CI. | One small, dependency-free artifact every shell can bundle; the size budget keeps it a good guest. |
| F1-D16 | **Tests = Vitest + `happy-dom`**; DOM assertions via `@testing-library/dom` + `@testing-library/user-event`; a11y via `@testing-library/jest-dom` matchers. An optional Playwright visual smoke sits behind a `PLAYWRIGHT=1` flag (not required for `pnpm verify`). | Fast, headless, deterministic; Playwright stays opt-in so CI needs no browser download. |
| F1-D17 | **Tokens single source = new `packages/tokens` (`@signal/tokens`).** It becomes the **canonical home** of `tokens.css` (raw file + a `tokensCss` string export). `design/final-version/tokens.css` is updated to re-export/point at it (styleguide imports from the package); web-core, and later the shells/hosted-link, all consume `@signal/tokens`. No copies. | Kills brand drift across web-core + shells + styleguide; one file, one workspace dep. |
| F1-D18 | **Custom emoji = 3 in-package inline SVG faces** (`src/assets/emoji/{negative,neutral,positive}.svg`), drawn in the brand style, **monochrome via `currentColor`** so they theme with tokens and animate. A dedicated task authors them; never system emoji (F1-D11). | Identical, themeable, animatable rating across every surface. |
| F1-D19 | **Fonts self-hosted, no runtime fetch.** JetBrains Mono + Inter shipped as **subset woff2** in `@signal/tokens`, referenced via `@font-face` with `font-display:swap` + a system fallback stack. No Google Fonts network call at runtime. | Privacy, offline, and no third-party dependency inside a guest app. |
| F1-D20 | **Config type source = `@signal/contracts`.** The SDK eligibility config schema (extended by B5 with `positive_action`/`negative_action`) is the single type; web-core imports the inferred `WorkflowConfig` + `Answer` types and reads a `config_version` field for the F1-D10 handshake. | One contract shared by backend, web-core, and (via the bridge envelope) the shells. |

---

## Public surface

```ts
// @signal/web-core
export function mount(root: HTMLElement, config: WorkflowConfig, host: SheetHost): SheetHandle
interface SheetHost {
  submit(answer: Answer): Promise<void>        // record; resolves when persisted/queued
  dismiss(reason: 'swipe'|'backdrop'|'esc'): void
  requestUpload(file: File): Promise<string>   // returns the stored image URL
  openReview(): void                           // native in-app review
  openUrl(url: string): void                   // redirect
  onResize?(height: number): void              // native shells size the WebView
}
interface SheetHandle { close(): void }
```

---

## Implementation details (pinned)

**Package layout**
```
packages/tokens/                 # @signal/tokens (NEW, canonical brand source)
  tokens.css                     # moved here from design/final-version (which now re-exports)
  fonts/*.woff2                  # subset JetBrains Mono + Inter
  src/index.ts                   # export const tokensCss: string; font URLs
packages/web-core/               # @signal/web-core
  src/
    mount.ts                     # public mount(); shadow-root + tokens injection
    machine.ts                   # pure state machine (no DOM)
    view/                        # rating.ts, detail.ts, submitting.ts, done.ts, backdrop.ts
    host.ts                      # SheetHost + bridge message types
    assets/emoji/{negative,neutral,positive}.svg
    types.ts                     # re-exports WorkflowConfig/Answer from @signal/contracts
  demo/standalone.html           # hosted-link harness + mock host
  tsup.config.ts
```

**State machine states** (F1-D4): `rating → detail → submitting → done` with `done` resolving the
action (`close | thanks | redirect | store_review`). `dismissed` is terminal and reachable from
`rating`, `detail`, `submitting` (submit still completes via host). `detail` is **skipped** when the
negative branch has no capture (F1-D12). Guards: `positive = rating >= positive_threshold`.

**Cross-language bridge (authored here as `docs/sheet-bridge-v1.md`, consumed by F2 shells)**
```
host → core:   INIT { config, config_version }          // mount the sheet
core → host:   READY {}                                  // core mounted, ready for INIT ack
core → host:   SUBMIT { answer }                         // record (precious)
core → host:   DISMISS { reason }
core → host:   REQUEST_UPLOAD { fileRef } → UPLOAD_RESULT { url | error }
core → host:   OPEN_URL { url } | OPEN_REVIEW {}
core → host:   RESIZE { height }                         // native sizes the WebView
```
On web the "bridge" is direct function calls (the `SheetHost` object); on native the same messages
cross the `@JavascriptInterface` / `WKScriptMessageHandler` boundary as JSON. Versioned by
`bridge_version`; unknown message types are ignored (forward-compat).

**Build outputs / budget** (F1-D15): ESM + IIFE + d.ts; `tokensCss` + emoji inlined; **≤ 35 KB gzip**
(core, excl. fonts) checked in CI. No runtime dependencies.

## Tasks

### Task 0 — `@signal/tokens` package (F1-D17,D19)
Create `packages/tokens`; **move** `design/final-version/tokens.css` here as canonical and update the
design styleguide + `design/final-version` to import/point at it; add subset woff2 fonts + `@font-face`;
export `tokensCss` string. **Verify:** styleguide still renders; `@signal/tokens` builds; no duplicate
tokens file remains.

### Task 1 — Package scaffold (F1-D1,D2,D15,D16)
`packages/web-core`: `package.json`, tsconfig (extends base), `tsup`/Vite lib build (ESM + IIFE), `@signal/contracts` dep, Vitest + happy-dom. A Shadow-DOM root helper that injects `tokens.css` (imported as a string). **Verify:** builds; a trivial `mount` renders an empty sheet into a shadow root in a DOM test.

### Task 2 — Config + host types + state machine (F1-D3,D4)
Types from contracts (`WorkflowConfig`, `Answer`), the `SheetHost` interface, and a pure state machine (states, transitions, guards using `positive_threshold`). **Verify:** state-machine unit tests cover every transition incl. dismiss-from-any-state and the positive-immediate-submit path.

### Task 3 — Emoji SVG assets + rating step (F1-D5,D11,D18)
Author the 3 brand-style `currentColor` emoji SVGs (`negative/neutral/positive`); build the header
question + 3-point emoji control (keyboard + pointer), wired to the branch guard. **Verify:** DOM test
— selecting each emoji routes to the right branch per threshold; keyboard arrows/enter work; emoji are
inline SVG (not font glyphs) and inherit `currentColor`.

### Task 4 — Negative detail step (F1-D6,D7)
Comment field (required iff `other_requires_text`) + photo attach (guardrails + `host.requestUpload`, thumbnail, remove). **Verify:** DOM test — required-comment blocks submit; photo attach calls host and shows thumbnail; oversized/wrong-type rejected.

### Task 5 — Submit + post-submit actions (F1-D4)
Submitting state (calls `host.submit`), then resolve the `positive_action`/`negative_action`: `none`→close, `thanks`→message, `redirect`→`host.openUrl`, `store_review`→`host.openReview`. Record before redirect. **Verify:** DOM test — each action type drives the right host call/close; failure of `submit` shows a retry affordance (host still queues via outbox in F2).

### Task 6 — Motion, theming, a11y (F1-D8,D9)
Enter/exit + branch transitions from tokens; dark mode via `prefers-color-scheme`; focus trap, ARIA, Esc/keyboard, reduced-motion. **Verify:** a11y test (roles/labels/focus trap); reduced-motion disables animation.

### Task 7 — Standalone hosted-link harness + demo (F1-D2)
A tiny standalone HTML/entry that mounts the sheet full-page from a config (for the hosted preview link and visual review), with a mock `SheetHost` logging calls. **Verify:** open the demo; run through both branches + all action types manually; committed screenshots or a Playwright smoke.

### Task 8 — Versioning + package polish (F1-D10)
Config version guard + graceful unknown-field handling; README with the embedding contract; bundle-size check. **Verify:** `pnpm verify` (typecheck/lint/test) green incl. the new package.

---

## Edge cases & failure modes

**Config**
- Missing/malformed required field (no `question`, no `rating`, no `positive_threshold`) → the core **does not mount** and calls `host.dismiss('config_invalid')` (fail closed, never a broken sheet).
- Unknown `rating` type (star/effort arrive before their UI) → render the emoji fallback and log; don't crash.
- Config version newer than the bundle supports → render what's understood, ignore unknown fields (F1-D10); if a *required* field is unknown, fail closed.
- `positive_threshold` out of the rating range → clamp into range.

**Rating step**
- No rating selected → cannot advance; the continue affordance is disabled/absent (tapping a face is the advance).
- Middle/neutral face routing is purely `>= threshold` (e.g. threshold=3 ⇒ only 😊 positive; 😐/😞 negative).
- Rapid multi-tap / double-tap on a face → debounced; one transition.
- Keyboard: arrows move selection (with wrap), Enter selects; focus visible.

**Negative detail (comment + photo)**
- Comment required (`other_requires_text`) but empty or **whitespace/newline-only** → inline error, submit blocked.
- Very long comment → soft max (e.g. 2000 chars) with counter; emoji/Unicode/RTL accepted; textarea auto-grows within a cap.
- Photo: disallowed type (not jpg/png/webp; e.g. HEIC/gif/svg) → rejected with a message; oversized → **downscaled client-side** (max dimension + quality) before `requestUpload`; still too big → rejected.
- Only **one** photo (v1); re-attach replaces; remove clears.
- `host.requestUpload` **rejects/times out** → show "couldn't attach", let the user retry or **submit without the image** (never block the whole response on an image).
- Upload in flight → submit disabled with progress; user dismisses mid-upload → cancel the upload, discard.

**Submit & post-submit**
- Double-submit (double tap / Enter twice) → guarded; exactly one `host.submit`.
- `host.submit` **rejects** (network) → the host still queues to the outbox (F2), so the core shows the success/thanks state optimistically once the host resolves "queued"; if the host signals hard failure, show a retry affordance.
- `redirect`/`store_review` fire **only after** submit resolves; `redirect` uses `host.openUrl` (host decides tab/in-app browser); `store_review` uses `host.openReview` (no-op/fallback where unsupported, per B5).
- Positive with `type:none` → submit then close; `type:thanks` → show message then auto-close after a short dwell.

**Dismissal & lifecycle**
- Dismiss via swipe-down, backdrop tap, Esc, or Android hardware back → all map to `host.dismiss(reason)`.
- Dismiss **during submitting** → the submit still completes via the host/outbox (precious); the UI just closes.
- Backend semantics: dismiss vs submit drive suppression server-side (dismiss = cooldown, submit = never re-ask) via `trigger_id` — the core only reports the event.
- Unmount → remove all listeners/timers, restore focus to the previously focused host element, no leaks.

**Rendering context**
- Host page CSS/JS can't leak in (Shadow DOM); host `!important` styles don't reach the sheet.
- Small viewports, landscape, notch/safe-area insets respected; on native the soft keyboard covering the comment field → the shell sends new height via `onResize`, the sheet scrolls the field into view.
- `prefers-color-scheme` drives dark/light; `prefers-reduced-motion` disables all animation (instant states); high-contrast/forced-colors mode stays legible.
- Taps during the enter animation are ignored until interactive.

**Accessibility**
- On open: `role="dialog"`+`aria-modal`, focus moves into the sheet, focus is trapped; on close focus returns.
- All controls labelled; emoji faces have text alternatives; submit result announced via an `aria-live` region; min 44px tap targets.

## Exit checklist
- [ ] `@signal/web-core` mounts a config-driven sheet in a Shadow DOM; core never calls the network (only the `SheetHost`).
- [ ] Emoji rating → branch → (positive action) / (negative comment+photo) → submit → resolved post-submit action, all covered by tests.
- [ ] Photo attach goes through `host.requestUpload`; guardrails enforced.
- [ ] Motion from tokens, dark mode, focus trap + keyboard + reduced-motion all working.
- [ ] Standalone demo runs both branches and every action type; `pnpm verify` green.

## Hand-off to F2
The renderer is done and pure. **F2** wraps it with real transport per surface (web SDK, Android/iOS/RN shells, hosted-link route) — implementing `SheetHost` with eligibility calls, the offline outbox, suppression, and presigned uploads.
