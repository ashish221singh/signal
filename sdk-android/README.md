# Signal SDK (Android)

In-app CSAT / CES feedback for BeatRoute's field-rep app. Signal turns a single
one-line hook at the right moment into a full feedback loop: it asks the backend
whether *this* user, on *this* named **event**, is eligible; if so it renders a
config-driven sheet — a **WebView hosting the bundled `@signal/web-core`**, the
same renderer that powers the web SDK — persists the answer, and reports it. When
nothing should be asked, the SDK stays completely invisible — no sheet, no
blocking, no crash. It is guest-safe by construction: every hook is a no-op before
`init` and no failure path is allowed to degrade the host app.

> **F2 refit.** The sheet is no longer a native Android View. It is a WebView
> shell that loads a **bundled** web-core build (`assets/web-core/`, never fetched
> at show time) and bridges the sheet's impure intents — submit / dismiss / upload
> / redirect / review — to native over `@JavascriptInterface` per
> [`docs/sheet-bridge-v1.md`](../docs/sheet-bridge-v1.md). The tested transport
> (eligibility client, Room + WorkManager outbox, DataStore suppression, the
> `Signal.init` / `Signal.trackEvent` public API) is reused; only the native sheet
> was replaced. Triggers are now **event-keyed** (`event_name`), so `screen_id` /
> `client_id` and the screen-dwell hooks are gone.

This is the canonical integration + testing guide for the SDK. The module README
(`signal-sdk/README.md`) is just a pointer here.

---

## 1. What it is

- **One hook, full loop.** You place `trackEvent` at meaningful moments. The SDK
  owns everything after that: eligibility, suppression, the (WebView) sheet,
  upload, and delivery.
- **Invisible when there's nothing to ask.** Eligibility is checked silently;
  the sheet only appears when the backend says yes and the local suppression
  floor allows it.
- **Never degrades the host.** All work runs on an SDK-owned supervised coroutine
  scope; every hook and flow is wrapped so a thrown failure can never propagate
  to the host. No Compose, no DI framework, no required lifecycle wiring beyond a
  single `init`.

---

## 2. Install & requirements

| Requirement    | Value                                               |
| -------------- | --------------------------------------------------- |
| JDK            | 17                                                  |
| Android SDK    | platform-34 (`compileSdk 34`)                       |
| `minSdk`       | 24                                                  |
| Language       | Kotlin; sheet renders in a `WebView` (bundled web-core) |
| WebView        | System WebView present + enabled (fail-silent if absent) |

The release artifact is `signal-sdk-release.aar`, produced by CI (see
[§6 Build & test](#6-build--test)) at
`signal-sdk/build/outputs/aar/signal-sdk-release.aar`. The module is a standard
`com.android.library` (group `com.beatroute`, artifact `signal-sdk`) and is
Maven-publish-ready, but is **not yet published** to a repository — consume the
AAR directly (drop it into `libs/` and depend on it, or wire an internal Maven
repo) until publishing is turned on.

The Gradle wrapper self-provisions; you only need JDK 17 and the Android SDK
platform-34 installed.

---

## 3. One-time integration

Implement `SessionProvider` and call `Signal.init(...)` once, in
`Application.onCreate`. Identity is resolved by the SDK **on demand** from this
provider — you never pass identity into the hooks. `userId()` is the eligibility +
suppression subject; `repTenureDays()` feeds the optional min-session-age gate
(sent as `session_age_days`). `clientId()` is retained on the interface for
source compatibility but is no longer sent to eligibility (the event model dropped
`client_id`).

```kotlin
import android.app.Application
import com.beatroute.signal.Signal
import com.beatroute.signal.SignalEnvironment
import com.beatroute.signal.SessionProvider

class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()

        val session = object : SessionProvider {
            override fun userId(): String = auth.currentRepId()
            override fun clientId(): String = context.currentClientId()
            // Return null when unknown — the backend then fails CLOSED on
            // tenure-gated campaigns rather than assuming eligibility.
            override fun repTenureDays(): Int? = auth.repTenureDays()
        }

        Signal.init(
            context = this,
            environment = SignalEnvironment.STAGING,   // or PRODUCTION
            sessionProvider = session,
        )
    }
}
```

`SignalEnvironment` fixes both the base URL and the app key, so a normal build
just picks `STAGING` or `PRODUCTION` and is wired end to end.

**Local dev / emulator.** To point the SDK at a backend running on your host
machine, use the override params (an emulator reaches the host loopback via
`10.0.2.2`):

```kotlin
Signal.init(
    context = this,
    environment = SignalEnvironment.STAGING,
    sessionProvider = session,
    baseUrlOverride = "http://10.0.2.2:3000/",   // emulator → host loopback
    appKeyOverride = "dev-app-key",
)
```

> The base URLs / app keys baked into `SignalEnvironment` are documented
> placeholders (BeatRoute infra supplies the real values at integration time).
> Use the overrides for local dev and tests.

`init` is idempotent: calling it again tears down the previous scope and rebuilds
state, so you may safely re-init on an identity change.

---

## 4. Event hooks

The entire public surface is `Signal.init` + `Signal.trackEvent`. The hook is a
one-liner; identity is pulled internally from your `SessionProvider` and is
**never** passed in.

```kotlin
// A meaningful, named in-app event just completed.
Signal.trackEvent("order_completion")
```

- Call `trackEvent(eventName)` at meaningful moments (an order placed, a visit
  logged, checkout completed, etc.). A workflow configured for that `event_name`
  decides whether a sheet appears.
- An event with no matching workflow shows nothing (the backend records it for
  surfacing but returns not-eligible).
- Every hook is a silent no-op before `Signal.init` — a host that never inits (or
  chooses not to) is never affected.

> The screen-dwell hooks (`onScreenEnter` / `onScreenExit`) were removed in the F2
> refit; Signal fires on named events only.

---

## 5. How it behaves

**Fire-and-forget eligibility vs. the precious outbox.** These two paths are
deliberately asymmetric:

- **Eligibility is best-effort.** The `/eligibility` check has a 2-second call
  timeout and is invisible on any failure — no error, no retry, no user-visible
  effect. A dropped check simply means no sheet this time.
- **Answers are precious.** Once the rep submits (`/response`) or dismisses
  (`/dismiss`), that outcome is written to a Room + WorkManager **outbox** and
  retried on reconnect. It survives process death and is deduplicated by
  `trigger_id` (a unique `(triggerId, kind)` index), so a retry never
  double-delivers.

**7-day local suppression floor.** A DataStore-backed cache records the last ask
per `(eventName, userId)` and short-circuits eligibility calls for 7 days. This
is a floor, not the source of truth — the backend still owns real cooldowns; the
floor only avoids obviously-too-soon network round-trips.

**Config-driven sheet (bundled web-core).** The sheet is a `WebView` that loads
the bundled `assets/web-core/sheet.html` harness, waits for its JS `ready` signal,
then receives the **raw** eligibility config JSON — native does not parse the full
config (per [`docs/sheet-bridge-v1.md`](../docs/sheet-bridge-v1.md), GR-2), it
relays it verbatim into web-core. web-core renders the rating control and the
positive / negative / other branches entirely from that config; the shared
renderer guarantees the sheet looks identical on web and Android. The sheet's
impure intents cross to native via the `SignalBridge` `@JavascriptInterface`:
`submit` → the precious outbox, `dismiss` → outbox dismiss + cooldown, `openUrl` →
browser, `openReview` → Play Store review, `resize` → sizing.

**Image attach.** Where enabled, the user can attach a photo. The photo
`<input type=file>` is routed to the native system picker via
`WebChromeClient.onShowFileChooser`; **web-core** then applies its own guardrails
(downscale, type/size caps) and performs the two-step **pre-signed** upload
(`POST /v1/sdk/uploads` → `PUT`) itself. The image is optional — any upload
failure lets the user submit text-only and the response is still delivered.

---

## 6. Build & test

Run from the `sdk-android/` directory. The wrapper self-provisions Gradle.

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk   # your Android SDK location

# Unit tests — pure JVM + Robolectric, no emulator or device needed.
./gradlew :signal-sdk:testDebugUnitTest

# Release AAR.
./gradlew :signal-sdk:assembleRelease
```

- Tests run on the JVM with Robolectric; **no emulator or connected device is
  required**. This is exactly what the `Android SDK` CI workflow runs.
- The release AAR lands at:
  `signal-sdk/build/outputs/aar/signal-sdk-release.aar`
  (CI uploads it as the `signal-sdk-aar` artifact).

---

## 7. Local backend

To exercise the full loop against a real backend on your machine, from the repo
root:

```bash
docker compose up -d                              # Postgres + MinIO
pnpm --filter @signal/api db:migrate              # schema
pnpm --filter @signal/api create-admin -- \
  --email pm@signal.local --name PM --password changeme123
pnpm --filter @signal/api seed                    # sample campaigns / config
pnpm --filter @signal/api dev                     # API on :3000
```

Then point the SDK at it from the app running in an emulator via the override
params in [§3](#3-one-time-integration):

```kotlin
baseUrlOverride = "http://10.0.2.2:3000/"   // 10.0.2.2 = host loopback from the emulator
```

(A device on the same LAN would instead use your machine's LAN IP.)

---

## 8. Manual QA checklist

Robolectric unit tests cover the transport wiring end to end: `trackEvent` →
eligibility (re-keyed to `event_name`) → the WebView sheet fragment shows and is
handed the bundled web-core → a bridge `submit` lands in the outbox and flushes →
suppression short-circuits the next event. A real WebView cannot execute the
web-core JS under Robolectric, so the **visual sheet render** (rating, branches,
dark mode, motion, a11y) is covered by the web-core JS test suite. The items below
need a **real device / emulator and a human** — they exercise the WebView bridge
in situ and the visual parity of the bundled renderer.

- **Full loop on device** — fire a `trackEvent` that matches a published workflow
  and confirm the WebView sheet appears, a submit is accepted, and (offline) the
  answer flushes on reconnect.
- **Rotation mid-flow** — open the sheet, type into the free-text field, rotate;
  confirm the retained fragment keeps the WebView state (no lost text / crash).
- **Hardware back** — press back with the sheet open; confirm it dismisses (a
  `dismiss` bridge message → cooldown) without crashing the host.
- **Photo attach** — in a config that allows an image, tap add-photo; confirm the
  native system picker opens (`onShowFileChooser`), the picked image uploads
  inside web-core, and a text-only submit still works if you cancel.
- **Redirect / store review** — for a workflow whose post-submit action is a
  redirect or store review, confirm `openUrl` opens the browser and `openReview`
  opens the Play Store listing.
- **Dark mode & motion** — toggle system dark theme and reduced-motion; confirm
  the web-core sheet honours them (this is web-core behaviour, verified visually).
- **WebView disabled/missing** — on a device with the system WebView disabled,
  confirm `trackEvent` fails silently (no sheet, no crash).

---

See the repo [`README.md`](../README.md), [`docs/signal-spec-v1.md`](../docs/signal-spec-v1.md),
and [`docs/signal-architecture-v1.md`](../docs/signal-architecture-v1.md) for the
product spec and system architecture.
