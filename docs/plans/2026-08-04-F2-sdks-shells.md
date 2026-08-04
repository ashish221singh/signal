# F2 — SDKs & Native Shells (transport around web-core) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wrap the F1 web-core sheet with real transport on each surface so it actually collects feedback: the **Web SDK** (`@signal/web`), the **hosted link**, the **Android** refit (WebView), and the new **iOS** and **React Native** SDKs. Each implements the `SheetHost` interface — eligibility call, config-driven render, the "precious" offline outbox, local suppression, presigned image upload, and the `track`/`init` public API. Also delivers the deferred CLI `init` (SDK install).

**Architecture:** Every shell hosts the **same bundled web-core** (no cold-fetch) and provides `SheetHost` I/O against the `/v1/sdk/*` API (publishable key). The write path is precious (durable outbox → retry → idempotent on `trigger_id`); eligibility is fire-and-forget (short timeout, fail-silent). Android reuses ~60% of the existing (now-deferred) Kotlin SDK — eligibility/feedback clients, Room+WorkManager outbox, suppression cache, trigger hooks — swapping the native View sheet for a WebView. iOS and RN mirror the same three concerns.

**Tech Stack:** Web: TS + `@signal/web-core`, IndexedDB (outbox), `fetch`/`sendBeacon`, Playwright (e2e). Android: Kotlin, WebView, OkHttp, Room, WorkManager (existing), JUnit/Robolectric. iOS: Swift, WKWebView, URLSession, JUnit-equivalent XCTest. RN: TS wrapper + native bridge. CLI: extend `@signal/cli` with `init`.

**Prerequisites:** **F1 merged** (`@signal/web-core` + `@signal/tokens` + `docs/sheet-bridge-v1.md`). Backend `/v1/sdk/*` (B1–B5) live. Per-surface toolchains (verify before starting each; **absent ⇒ skip that surface with a note, per F2-D15**):
- **Web SDK / hosted link:** Node 22 + pnpm (present). Playwright browser download only if running the opt-in e2e.
- **Android:** JDK 17 (present), `ANDROID_HOME` + SDK (present), gradle wrapper in `sdk-android/` (present) → **buildable here**.
- **iOS:** **full Xcode** (currently only Command Line Tools → **blocked; skip with note**).
- **React Native:** Node + RN CLI + CocoaPods (+ Xcode for iOS side) → verify; likely fast-follow.

---

## Decisions & Edge Cases (binding)

| # | Decision | Rationale |
|---|---|---|
| F2-D1 | **Build order & v1 scope:** Web SDK + hosted link + Android refit ship first (the highest-reach, lowest-risk set); **iOS + RN are a fast-follow** in the same milestone but may land after. | Web unblocks self-serve immediately; Android reuses the most existing code; iOS/RN are net-new and can trail without blocking launch. |
| F2-D2 | **Web SDK (`@signal/web`):** `Signal.init(key, {apiUrl?})` + `track(event, {userId, context?, sessionAgeDays?})`; mounts web-core in a Shadow DOM; `SheetHost` uses `fetch` to `/v1/sdk/*`, `localStorage` suppression, an **IndexedDB outbox** flushed on load/online, presigned upload via `/v1/sdk/uploads`. | The flagship surface; durable-enough offline without native storage. |
| F2-D3 | **Android refit:** keep `EligibilityClient`, `FeedbackClient`, Room+WorkManager outbox, `LocalSuppressionCache`, trigger hooks; **replace** `SignalBottomSheetFragment`/`RatingView`/XML with a `WebView` hosting the bundled web-core; bridge `SheetHost` over `@JavascriptInterface`. Re-key to `event_name` (drop screen/client). Remove `sdk-android/DEFERRED.md`. | Maximum reuse of tested code; one design language via web-core. |
| F2-D4 | **iOS SDK:** new Swift package — `WKWebView` + Swift ports of eligibility client, outbox (Core Data/SQLite + background task), suppression, presign. Public `Signal.init/track`. | Mirrors Android; JVM-free. |
| F2-D5 | **React Native:** thin TS wrapper reusing `@signal/web`'s renderer inside an RN `WebView` + a native trigger bridge; `Signal.init/track`. | Least code; leans on the web core. |
| F2-D6 | **web-core is bundled into every shell** (asset/dependency), never fetched at show time; the JS bridge is **versioned**. | Offline-safe, no cold-start latency; forward-compatible configs (F1-D10). |
| F2-D7 | **Hosted link:** a backend route serves the standalone web-core harness for a short-lived **preview token** minted by the console/CLI — used for the agent's "instant preview" and share-anywhere surveys. | Zero-SDK surface; powers the agent setup loop's verify step. |
| F2-D8 | **CLI `init`** (deferred from B3): detect project type, install the right SDK, add `Signal.init(publishableKey)`, print next steps. | Completes the agent setup loop's one-time install. |
| F2-D9 | **Anonymous id when `userId` is omitted.** Each shell generates and **persists** a stable anonymous id (localStorage / DataStore / UserDefaults) and uses it for suppression + `user_id`. If the host later passes a real `userId`, it takes over. | Suppression/cooldown need a stable subject; the SDK must work even when the app has no user id yet. |
| F2-D10 | **Eligibility is fail-silent; responses are precious.** Eligibility uses a short timeout (≈2s); any error/timeout/429/401/malformed → **no sheet, no throw, no crash** (log at debug). Responses persist to the durable outbox first, then flush with retry/backoff, drop after a max age/attempts, idempotent on `trigger_id`. | The SDK must never degrade the host app; a lost eligibility check is harmless, a lost answer is not. |
| F2-D11 | **Local suppression short-circuit.** Before calling eligibility, the shell checks its local suppression cache; if suppressed, it **skips the network entirely**. Server remains authoritative on a cache miss. | Saves API calls on the hot path (B1-D4 lineage) and works offline. |
| F2-D12 | **Storage fallback.** If durable storage is unavailable (web private mode / quota exceeded; native storage error) the outbox falls back to in-memory + a `sendBeacon`/best-effort flush on unload, and logs the degraded mode. | Never crash on storage; degrade to best-effort rather than losing the SDK entirely. |
| F2-D13 | **Android reuse/replace is enumerated (no guesswork).** **REUSE** (re-key to `event_name` where noted): `Signal.kt` (public API), `SessionProvider`, `SignalConfig`, `SignalEnvironment`, `internal/EligibilityClient`, `internal/FeedbackClient`, `internal/outbox/*` (Room + WorkManager), `internal/LocalSuppressionCache`, `internal/Json`, `internal/Models` (re-key), `internal/Trigger` + the `trackEvent` hook. **REPLACE/REMOVE:** `ui/SignalBottomSheetFragment`, `ui/RatingView`, `internal/SignalSheetPresenter`, `internal/SheetPresenter`, `res/layout/signal_*`, sheet drawables/colors, `internal/ImagePicker`, `internal/ImageProcessing`, `internal/UploadClient` (upload now happens in web-core), `internal/DwellTimer`/screen-dwell trigger (events only). **ADD:** `WebViewSheetFragment` (hosts bundled web-core), `SignalBridge` (`@JavascriptInterface` implementing the bridge messages), a `WebChromeClient.onShowFileChooser` to route the photo `<input>` to the native picker. | Turns "~60% reuse" into an exact file list so the refit is mechanical, not archaeological. |
| F2-D14 | **web-core is a bundled build artifact per shell.** A workspace build step copies `@signal/web-core` `dist` (IIFE + inlined tokens/emoji) into: web SDK (npm dep), Android `signal-sdk/src/main/assets/web-core/`, iOS bundle resources, RN package assets. A pinned `WEB_CORE_VERSION` + a bridge-version handshake guard drift. | No cold-fetch; deterministic, offline-safe; one renderer everywhere. |
| F2-D15 | **iOS/RN are gated on toolchains (fast-follow).** iOS needs **full Xcode** (CLT-only won't build a Swift package/`WKWebView` app); RN needs Node + the RN CLI + CocoaPods (+ Xcode for the iOS side). These tasks are **skipped with a clear note** if the toolchain is absent, not faked. Web + Android + hosted link do not depend on them. | Matches the environment reality; keeps v1 shippable without Apple tooling. |
| F2-D16 | **Hosted-link preview:** `POST /v1/console/preview` (scope `workflows:read`) → a short-lived **signed token** (`exp` ≈ 30 min) embedding `{account_id, workflow_id or inline config, mode:'preview'}`; `GET /s/preview/:token` serves the standalone web-core harness with a **default `SheetHost`** in **preview mode** — `submit` persists a response flagged `is_preview=true` (or echoes without persisting; choose persist-flagged so the loop is real), uploads use a scoped presign, `redirect`/`store_review` are shown but inert. | Powers the agent's "instant preview" from the setup loop; account-scoped and expiring; never pollutes real metrics (preview flag). |
| F2-D17 | **Anonymous id (F2-D9) storage per platform:** web `localStorage['signal_anon_id']`; Android DataStore; iOS `UserDefaults`; a UUIDv4 generated once and reused. A host-supplied `userId` supersedes it for that call. | Stable suppression subject on every surface, generated lazily, survives restarts. |
| F2-D18 | **Outbox specifics:** web = IndexedDB store `outbox {id, payload, attempts, nextAttemptAt, createdAt}`, flush on load/`online`/`visibilitychange`, `sendBeacon` last-ditch on `pagehide`; Android = existing Room + WorkManager (network-constrained, exponential backoff); iOS = SQLite/CoreData + `BGTaskScheduler` + background `URLSession`. Drop after `maxAttempts=8` or `maxAge=7d`; idempotent on `trigger_id`. | Durable, offline-safe, bounded retry; identical semantics across platforms. |

---

## Tasks

1. **Web SDK core (`@signal/web`)** — `init`/`track`, web-core mount, `SheetHost` via `fetch`, suppression (localStorage). **Verify:** Playwright e2e — track → sheet → submit hits a mock/local API; suppression short-circuits repeat.
2. **Web outbox + uploads** — IndexedDB durable queue, flush on load/online, idempotent on `trigger_id`; presigned image upload. **Verify:** e2e — offline submit queues and flushes on reconnect; image uploads via presign.
3. **Hosted link route (F2-D7)** — backend serves the standalone harness for a preview token; CLI/console mint the token. **Verify:** int test — preview token renders a config; expired token 404.
4. **Android refit (F2-D3,D13,D14)** — follow the F2-D13 reuse/replace file list exactly: keep the networking/outbox/suppression/public-API files (re-key `Models`/eligibility to `event_name`); delete the native sheet + image files; add `WebViewSheetFragment` + `SignalBridge` + `WebChromeClient` file-chooser; copy the web-core artifact into `assets/web-core/` (F2-D14); delete `sdk-android/DEFERRED.md`. **Verify:** Robolectric/JVM — trackEvent → WebView sheet loads bundled web-core → bridge SUBMIT → outbox flush; back-button dismiss; dark/theme; e2e against a local API.
5. **CLI `init` (F2-D8)** — install SDK + inject `Signal.init`. **Verify:** CLI e2e in a fixture web project.
6. **iOS SDK (F2-D4)** — WKWebView + Swift transport/outbox/suppression. **Verify:** XCTest — eligibility, submit→outbox, suppression.
7. **React Native (F2-D5)** — wrapper + trigger bridge over `@signal/web`. **Verify:** RN test/harness — track → sheet → submit.
8. **Cross-surface parity + version guard** — bundle web-core into each shell; assert the bridge/config version handshake. **Verify:** `pnpm verify` green for JS packages; native suites green; a parity checklist (same config → same states on web + Android).

---

## Edge cases & failure modes

**Init / track lifecycle**
- `track` called **before** `init` → no-op + one dev warning (queue-and-flush is not worth it in v1).
- `init` called **twice** / SDK script loaded twice on a page → idempotent single instance; second `init` updates config, doesn't duplicate.
- `track` for an event with **no matching workflow** → backend returns not-eligible; the SDK still records the event for surfacing (B3 `seen_events`) and shows nothing.
- Rapid/duplicate `track` while a sheet is open or during the eligibility call → coalesced; one sheet (F1-D13), no double eligibility for the same open trigger.

**Eligibility path (fail-silent, F2-D10)**
- Timeout (>2s), DNS/offline, 5xx, 429, malformed JSON → no sheet, no throw.
- **401 (revoked/rotated key)** → fail silent + debug log; do not retry aggressively.
- Suppressed locally (F2-D11) → skip the call entirely.
- Clock skew on the device → irrelevant (cooldowns computed server-side from `trigger_id`/server time).

**Outbox / responses (precious)**
- Submit while **offline** → queued durably; UI shows success (queued); flush on reconnect.
- App **killed** before flush → survives in durable storage; flushed on next launch (WorkManager / BGTask / on web: next load).
- Retry with backoff; **drop** after max attempts or max age, logged; never infinite-loop.
- Idempotent replay: a response flushed twice (e.g. killed after send, before ack) → server dedups on `trigger_id` (B1 lineage) → 2nd is a benign 200.
- Storage unavailable / quota exceeded → F2-D12 fallback.

**Image upload**
- Presign request fails / expired URL → re-request once; if still failing, allow submit **without** the image (never block the answer).
- Upload PUT fails / interrupted → retry; on give-up, submit text-only.
- Oversized image → downscaled in web-core (F1) before the PUT.

**Web specifics**
- IndexedDB blocked (private mode) → in-memory + `sendBeacon` on `visibilitychange`/`pagehide`.
- Host **CSP** blocking inline/eval → the SDK ships as a normal script + Shadow DOM (no iframe, no eval); document any `connect-src` (the API origin) the host must allow.
- SPA route change mid-sheet → sheet persists until answered/dismissed (not tied to route).
- Multiple tabs → each has its own outbox; server idempotency covers any overlap.

**Android specifics**
- WebView missing/disabled (rare) or very old → fail silent (no sheet), no crash; document the min WebView.
- Config passed to the WebView only **after** the JS bridge signals `ready` (injection-timing race).
- Rotation/config-change while the sheet is open → WebView state preserved (retain the fragment/view) so the in-progress answer isn't lost.
- Hardware **back** → dismiss; Doze/background → WorkManager network-constrained flush.

**iOS / RN specifics**
- App suspended mid-upload → background `URLSession` task; RN JS thread paused → native trigger bridge buffers.

**Hosted link**
- Preview token **expired/invalid/wrong-account** → friendly 404 page, not a stack trace; the standalone page supplies a default `SheetHost` (submit → API with the preview's key, or read-only preview mode that doesn't persist).

**CLI `init`**
- Project type ambiguous / multiple frameworks → prompt or print manual steps rather than guessing wrong.
- SDK already installed → skip/upgrade, don't duplicate `Signal.init`.
- Entry file for `Signal.init` not found → print exact manual snippet.

**Versioning**
- Shell bundles web-core vX, backend config vY (newer) → forward-compat handshake (F1-D10); on a hard mismatch the sheet degrades, the SDK doesn't crash.

## Exit checklist
- [ ] Web SDK: `init`/`track` → web-core sheet → submit → response stored; IndexedDB outbox survives offline; presigned image upload works.
- [ ] Hosted link renders a config from a preview token.
- [ ] Android refit: WebView sheet from bundled web-core, event-keyed, outbox + suppression reused; native View sheet removed.
- [ ] iOS + RN: `init`/`track` → sheet → submit → outbox (fast-follow acceptable if flagged).
- [ ] CLI `init` installs the SDK and wires `Signal.init`.
- [ ] web-core bundled (not fetched) in every shell; bridge/config versions handshake; suites green.

## Hand-off to F3
Feedback now flows end to end from real apps into the account's data. **F3** builds the Signal web app: auth UI + the reporting dashboard that reads that data back.
