# Signal SDK (Android)

In-app CSAT / CES feedback for BeatRoute's field-rep app. Signal turns a single
one-line hook at the right moment into a full feedback loop: it asks the backend
whether *this* rep, on *this* screen, for *this* client is eligible; if so it
renders a config-driven bottom sheet (rating → follow-up → optional photo),
persists the answer, and reports it. When nothing should be asked, the SDK stays
completely invisible — no sheet, no blocking, no crash. It is guest-safe by
construction: every hook is a no-op before `init` and no failure path is allowed
to degrade the host app.

This is the canonical integration + testing guide for the SDK. The module README
(`signal-sdk/README.md`) is just a pointer here.

---

## 1. What it is

- **One hook, full loop.** You place `trackEvent` / `onScreenEnter` /
  `onScreenExit` at meaningful moments. The SDK owns everything after that:
  eligibility, suppression, the sheet, upload, and delivery.
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
| Language       | Kotlin, plain Android Views (no Compose)            |

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
provider — you never pass `user_id` / `client_id` / `rep_tenure_days` into the
hooks.

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

## 4. Per-screen hooks

The entire public surface is four methods. The hooks are one-liners; identity is
pulled internally from your `SessionProvider` and is **never** passed in.

```kotlin
// Action moment — a meaningful in-app event just completed.
Signal.trackEvent("order_completion")

// Dwell-based trigger — the rep entered / left a screen. If they dwell past the
// configured threshold without leaving, the trigger flow runs.
Signal.onScreenEnter("client_dashboard")
Signal.onScreenExit("client_dashboard")
```

- Use `trackEvent(screenId)` for **action** triggers (an order placed, a visit
  logged, etc.).
- Use `onScreenEnter` / `onScreenExit` (as a matched pair) for **dwell** triggers
  where lingering on a screen is the signal.
- Every hook is a silent no-op before `Signal.init` — a host that never inits (or
  chooses not to) is never affected.

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
per `(screenId, clientId)` and short-circuits eligibility calls for 7 days. This
is a floor, not the source of truth — the backend still owns real cooldowns; the
floor only avoids obviously-too-soon network round-trips.

**Config-driven sheet.** The bottom sheet renders entirely from campaign config:
the rating control is **star**, **emoji**, or **effort** (CES) as configured, and
the follow-up branches on the rating into a **positive**, **negative**, or
**other** path (e.g. positive thanks, negative chips + free text). Nothing about
the sheet is hardcoded per campaign.

**Image attach.** Where enabled, the rep can attach a photo. The SDK downscales
it (long edge ≤ 1600 px, re-encoded to JPEG, capped at 5 MB with one lower-quality
retry) and uploads it via a two-step **pre-signed** flow: `POST /v1/sdk/uploads`
returns an upload URL, the bytes are `PUT` directly to it. The image is optional —
any upload failure is swallowed and the response is still delivered.

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

Robolectric unit tests cover bottom-inset padding, the scrollable content
wrapper, the `values-night` dark paper, and rating content descriptions. The
items below need a **real device / emulator and a human** — motion, focus order,
and true inset / rotation behaviour can't be asserted in unit tests.

- **Rotation mid-flow** — open the sheet, select a low rating to reach NEGATIVE
  (or OTHER), rotate the device, and confirm the sheet survives the config change
  without losing typed text / crashing and re-lays out correctly.
- **Keyboard overlap on OTHER free-text** — in the OTHER sub-branch, focus the
  text field so the soft keyboard shows. The Submit button must stay visible
  above the keyboard (bottom IME inset padding), and the content must scroll if
  the sheet is shrunk.
- **Gesture-nav insets** — on a device using gesture navigation, confirm the
  Submit button and sheet bottom edge are not hidden behind the nav bar (bottom
  `systemBars` inset padding applied).
- **Small vs large devices** — verify on a compact phone (sheet full-width) and
  on a large phone / tablet (`sw600dp`: sheet width-capped and centred, not
  stretched edge-to-edge).
- **Long chip list** — configure many `chips_on_negative` entries and confirm the
  chip area scrolls inside the capped-height content region instead of clipping
  the Submit button.
- **Dark mode** — toggle system dark theme and confirm the sheet renders the dark
  paper / near-white ink (brand orange unchanged), with legible contrast in every
  state.
- **Reduced motion** — enable "Remove animations" (or set animator duration scale
  to 0 in Developer options) and confirm state transitions swap instantly with no
  fade; then re-enable and confirm the subtle fade returns.
- **TalkBack focus order** — enable TalkBack and confirm a sensible traversal:
  header → close, then rating elements announce "Rate N of M", chips announce
  their label + selected state, and Submit / Add photo are reachable and
  labelled.

---

See the repo [`README.md`](../README.md), [`docs/signal-spec-v1.md`](../docs/signal-spec-v1.md),
and [`docs/signal-architecture-v1.md`](../docs/signal-architecture-v1.md) for the
product spec and system architecture.
