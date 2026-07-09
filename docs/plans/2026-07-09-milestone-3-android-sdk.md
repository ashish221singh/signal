# Milestone 3 — Android SDK Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship `com.beatroute:signal-sdk` — a Kotlin Android library that turns a one-line hook call into the full feedback loop (eligibility → config-driven bottom sheet → response/dismiss), invisible when it has nothing to say, never degrading the host app, proven by JVM/Robolectric tests and a scripted end-to-end run against the real backend.

**Architecture:** Per `signal-architecture-v1.md` §6. A single Android library module `sdk-android/signal-sdk`. Public surface is exactly the `Signal` object (`init` / `trackEvent` / `onScreenEnter` / `onScreenExit`); everything else is `internal`. Two data paths (architecture §6.1): **eligibility is fire-and-forget** (2s timeout, fail-silent, nothing lost on failure) and **responses/dismisses are precious** (persisted to a Room + WorkManager outbox, retried on reconnect, deduplicated by the backend on `trigger_id`). One config-driven `SignalBottomSheetFragment` renders all four view states (spec §5). Images upload directly to a pre-signed S3 URL, never through `/response` (spec §6.3).

**Tech Stack:** Kotlin + coroutines, OkHttp, kotlinx.serialization, Room, DataStore Preferences, Material Components (Android View system — **no Compose, no DI framework**; the SDK is a guest in the host process). Backend additions in `apps/api`: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, MinIO for local dev. JVM tests via JUnit4 + Robolectric + MockWebServer; no emulator required.

**Prerequisites (hard gates):**
1. **M2 merged.** Phase 0 adds a route + env to `apps/api`, which the M2 session owns. Do Phase 0 only after M2 lands on `main`, to avoid conflicts.
2. Cooldown reconciliation applied (done — commit `51bf8b0`). Cooldown language throughout is `after_7_days | after_30_days | after_60_days`.
3. Local toolchain: JDK 17 (present), Android SDK at `$ANDROID_HOME` (present). No global Gradle needed — the wrapper self-provisions.

---

## Decisions & Edge Cases (binding — do not re-litigate during execution)

| # | Decision | Rationale / edge case covered |
|---|---|---|
| M3-D1 | Full scope incl. image upload | Product owner call; the "Other" branch supports a photo attach |
| M3-D2 | Images go to an **S3-compatible** store via a **pre-signed PUT**: AWS S3 in prod, MinIO (docker-compose) locally. The image never travels inside `/response` | Spec §6.3; keeps the response payload small and the loop offline-safe |
| M3-D3 | Verification is **local**: `./gradlew :signal-sdk:testDebugUnitTest` (JUnit + Robolectric + MockWebServer, JVM-only, no emulator), plus a committed CI job. Instrumented/emulator tests are out of scope | Robolectric renders the sheet on the JVM; matches architecture §8 |
| M3-D4 | Bottom sheet is **native Android**; visuals are lifted from the console prototype's phone-preview (`prototypes/signal-console-prototype.html`, the `.preview-col`) and the `--sg` tokens are ported to an Android theme (light + dark) | One design language across web and native; no new mockup needed |
| M3-D5 | Stack: Kotlin + coroutines, OkHttp, kotlinx.serialization, Room, DataStore, Material. **No Compose, no DI.** `minSdk 24`, `compileSdk 34`, `targetSdk 34` | Minimal transitive baggage — a guest library must not version-conflict with the Route app. minSdk 24 ≈ Android 7; confirm against the Route app's floor |
| M3-D6 | Distributed as an **in-repo AAR built by CI**, Maven-publish-ready but not published | Spec §13 — defer a Maven repo until a second app needs it |
| M3-D7 | **Eligibility is fire-and-forget** (2s timeout, any failure → show nothing, lose nothing, no retry). **`/response` and `/dismiss` are precious** → Room+WorkManager outbox, retried on reconnect; backend idempotency on `trigger_id` means retries never double-count | Architecture §6.1; the core asymmetry of the SDK |
| M3-D8 | SDK JSON models are validated against **checked-in fixture files** whose shapes mirror `packages/contracts`. A generator script from the Zod schemas is a nice-to-have, deferred; fixtures are hand-authored from the contract and reviewed | "One source of truth" (architecture §8) without a build-time cross-language codegen dependency in M3 |
| M3-D9 | `LocalSuppressionCache` is an **optimization only**, never authoritative. After any completed interaction for `(screenId, clientId)` it short-circuits eligibility calls for a **7-day local floor** (the minimum server cooldown). The backend's atomic claim stays the source of truth | Saves mobile-data round-trips; a 7-day floor can never suppress a legitimate ask early (min real cooldown is 7 days), and under-caching just costs one harmless 204 |
| M3-D10 | `user_id` / `client_id` / `rep_tenure_days` come from a host-provided `SessionProvider`, resolved internally per call — never passed by the integrator | Spec §9.1; one-line hooks stay one line |
| M3-D11 | The sheet uses its own Material **theme overlay**; it neither inherits nor mutates the host app's theme | An SDK must look correct regardless of the host's styling |
| M3-D12 | `Signal.init` takes an `environment` (STAGING / PRODUCTION) that fixes the base URL and the app key; debug host builds hit staging | Architecture §6 |
| M3-D13 | SDK auth = static `X-Signal-App-Key` header on every backend call (matches M1-D14). The upload endpoint is under `/v1/sdk` behind the same app-key auth | One auth model for the SDK surface |
| M3-D14 | Image guardrails in the SDK: max 5 MB after a client-side downscale to ≤1600px long edge; types jpeg/png/webp only | Protects the rep's data plan and the bucket |
| M3-D15 | Error body parsed as `{ error: { code, message } }` (M1-D18), but eligibility errors are swallowed silently; only outbox uses the code to decide retry vs drop | Never make the host app worse |
| M3-D16 | The SDK owns a single supervised `CoroutineScope` (`SupervisorJob` + `Dispatchers.Main.immediate` for UI, IO offloaded); one thrown coroutine never crashes the host | Guest-safety |

---

## PHASE 0 — Backend: pre-signed upload endpoint (in `apps/api`; only after M2 merges)

### Task 0.1: S3/MinIO env + local compose service

**Files:**
- Modify: `docker-compose.yml` (add a `minio` service + `createbuckets` init)
- Modify: `apps/api/src/env.ts`, `apps/api/src/env.test.ts`
- Modify: `.env.example`

**Step 1: Add MinIO to `docker-compose.yml`**

```yaml
  minio:
    image: minio/minio:latest
    container_name: signal-minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: signal
      MINIO_ROOT_PASSWORD: signal_local_dev
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - signal_minio:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 3s
      retries: 10
  createbuckets:
    image: minio/mc:latest
    depends_on:
      minio:
        condition: service_healthy
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 signal signal_local_dev;
      mc mb --ignore-existing local/signal-feedback-images;
      mc anonymous set download local/signal-feedback-images;
      exit 0;"
```
Add `signal_minio:` to the top-level `volumes:` map.

**Step 2: Extend env (TDD — add to `env.test.ts` first)**

New tests: `S3_ENDPOINT` defaults to `http://localhost:9000`, `S3_BUCKET` to `signal-feedback-images`, `S3_REGION` to `us-east-1`, `S3_ACCESS_KEY`/`S3_SECRET_KEY` default to the dev creds in non-production and **throw in production when unset** (same fail-fast pattern as `SIGNAL_APP_KEYS`); `S3_PUBLIC_URL` defaults to `http://localhost:9000/signal-feedback-images`.

Implementation additions to `env.ts` schema:
```ts
S3_ENDPOINT: z.url().optional(),
S3_REGION: z.string().optional(),
S3_BUCKET: z.string().optional(),
S3_ACCESS_KEY: z.string().optional(),
S3_SECRET_KEY: z.string().optional(),
S3_PUBLIC_URL: z.url().optional(),
```
…then in `parseEnv`, after the existing resolution, default the S3 values for non-production and require `S3_ACCESS_KEY`/`S3_SECRET_KEY` in production (extend the existing "missing required in production" list). Expose them on `Env` as non-optional strings (dev defaults: endpoint `http://localhost:9000`, region `us-east-1`, bucket `signal-feedback-images`, access `signal`, secret `signal_local_dev`, publicUrl `http://localhost:9000/signal-feedback-images`).

**Step 3: Update `.env.example`** with the six `S3_*` vars and their local values.

**Step 4: Verify** — `pnpm test` (env unit tests green), `pnpm typecheck`.

**Step 5: Commit** — `chore(api): minio for local image storage + s3 env`

---

### Task 0.2: Pre-signed upload contract + route

**Files:**
- Create: `packages/contracts/src/uploads.ts`, test `packages/contracts/src/uploads.test.ts`; export from `index.ts`
- Create: `apps/api/src/uploads/presign.ts`, `apps/api/src/routes/uploads.ts`
- Modify: `apps/api/src/app.ts` (mount under the existing app-key-guarded `/v1/sdk` scope)
- Test: `apps/api/test/uploads.int.test.ts`
- Install: `pnpm --filter @signal/api add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`

**Step 1: Contract (TDD)** — `uploadRequestSchema = z.object({ content_type: z.enum(['image/jpeg','image/png','image/webp']) })`; `uploadTicketSchema = z.object({ upload_url: z.url(), object_url: z.url(), key: z.string() })`. Unit `safeParse` tests: rejects a non-image content type; accepts a valid one.

**Step 2: Presign service**

```ts
// apps/api/src/uploads/presign.ts
import { randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../env.js';

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
};

export function makeS3(env: Env): S3Client {
  return new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true, // MinIO
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  });
}

export async function presignUpload(
  s3: S3Client, env: Env, contentType: string,
): Promise<{ upload_url: string; object_url: string; key: string }> {
  const key = `feedback/${randomUUID()}.${EXT[contentType] ?? 'bin'}`;
  const upload_url = await getSignedUrl(
    s3, new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: 300 },
  );
  return { upload_url, object_url: `${env.S3_PUBLIC_URL}/${key}`, key };
}
```

**Step 3: Route** `POST /v1/sdk/uploads` — parse `uploadRequestSchema` (422 on bad type), call `presignUpload`, return 200 `uploadTicketSchema`. Mount inside the existing `/v1/sdk` app-key scope in `app.ts`; construct one `S3Client` at app build and pass it in (close is a no-op).

**Step 4: Failing integration test** (`uploads.int.test.ts`, Testcontainers MinIO via `GenericContainer('minio/minio').withCommand(['server','/data'])`, or reuse a running compose MinIO if `S3_ENDPOINT` is set):
1. No app key → 401
2. `{ content_type: 'image/png' }` → 200, body matches `uploadTicketSchema`; a real `PUT` of bytes to `upload_url` returns 200; a `GET` of `object_url` returns those bytes
3. `{ content_type: 'application/pdf' }` → 422

**Step 5: Verify green** — `pnpm verify`.

**Step 6: Commit** — `feat(api): pre-signed image upload endpoint for the SDK`

---

## PHASE A — Gradle project scaffold

### Task A.1: Library module that builds and tests

**Files:**
- Create: `sdk-android/settings.gradle.kts`, `sdk-android/build.gradle.kts`, `sdk-android/gradle.properties`
- Create: `sdk-android/gradlew`, `sdk-android/gradlew.bat`, `sdk-android/gradle/wrapper/gradle-wrapper.properties`, `gradle-wrapper.jar`
- Create: `sdk-android/signal-sdk/build.gradle.kts`, `sdk-android/signal-sdk/src/main/AndroidManifest.xml`
- Create: `sdk-android/signal-sdk/src/test/kotlin/com/beatroute/signal/SmokeTest.kt`
- Modify: root `.gitignore` (add `sdk-android/.gradle/`, `sdk-android/build/`, `sdk-android/**/build/`, `.cxx/`, `local.properties`)
- Create: `sdk-android/local.properties` is NOT committed; document that `sdk.dir` comes from `$ANDROID_HOME`

**Step 1: Generate the wrapper** — from `sdk-android/`, run `gradle wrapper --gradle-version 8.9` if a global gradle exists; otherwise create `gradle/wrapper/gradle-wrapper.properties` pointing at `gradle-8.9-bin.zip` and vendor the standard `gradlew`/`gradlew.bat`/`gradle-wrapper.jar` (the wrapper jar is committed — it's ~60KB and required for `./gradlew` to bootstrap).

**Step 2: `settings.gradle.kts`**
```kotlin
pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories { google(); mavenCentral() }
}
rootProject.name = "signal-sdk-root"
include(":signal-sdk")
```

**Step 3: Root `build.gradle.kts`**
```kotlin
plugins {
  id("com.android.library") version "8.5.2" apply false
  id("org.jetbrains.kotlin.android") version "2.0.20" apply false
  id("org.jetbrains.kotlin.plugin.serialization") version "2.0.20" apply false
}
```

**Step 4: `signal-sdk/build.gradle.kts`**
```kotlin
plugins {
  id("com.android.library")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.serialization")
}
android {
  namespace = "com.beatroute.signal"
  compileSdk = 34
  defaultConfig { minSdk = 24 }
  buildTypes { release { isMinifyEnabled = false } }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  kotlinOptions { jvmTarget = "17" }
  testOptions { unitTests { isIncludeAndroidResources = true } } // Robolectric resources
  buildFeatures { viewBinding = true }
}
dependencies {
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.1")
  implementation("androidx.room:room-runtime:2.6.1")
  implementation("androidx.room:room-ktx:2.6.1")
  annotationProcessor("androidx.room:room-compiler:2.6.1")
  // Room uses KSP normally; for plan simplicity use kapt or KSP — add `id("com.google.devtools.ksp")` and `ksp(...)` in Task G.1
  implementation("androidx.datastore:datastore-preferences:1.1.1")
  implementation("androidx.work:work-runtime-ktx:2.9.1")
  implementation("com.google.android.material:material:1.12.0")
  implementation("androidx.fragment:fragment-ktx:1.8.2")
  testImplementation("junit:junit:4.13.2")
  testImplementation("org.robolectric:robolectric:4.13")
  testImplementation("androidx.test:core:1.6.1")
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
  testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
```
(Note: switch Room to KSP in Task G.1 — `id("com.google.devtools.ksp") version "2.0.20-1.0.24"` and `ksp("androidx.room:room-compiler:2.6.1")`. Until Room is used, keep the dependency but no processor is required.)

**Step 5: `AndroidManifest.xml`** — minimal `<manifest package unset (namespace set in gradle)>` with no components.

**Step 6: Write the smoke test**
```kotlin
package com.beatroute.signal
import org.junit.Assert.assertEquals
import org.junit.Test
class SmokeTest { @Test fun `toolchain runs`() { assertEquals(4, 2 + 2) } }
```

**Step 7: Run it** — from `sdk-android/`: `ANDROID_HOME=$ANDROID_HOME ./gradlew :signal-sdk:testDebugUnitTest`. Expected: BUILD SUCCESSFUL, 1 test passed. (First run downloads Gradle + deps; allow a few minutes.)

**Step 8: Commit** — `chore(sdk): gradle android library scaffold that builds and tests`

---

### Task A.2: Signal theme from `--sg` design tokens

**Files:**
- Create: `signal-sdk/src/main/res/values/colors.xml`, `dimens.xml`, `type.xml`, `themes.xml`
- Create: `signal-sdk/src/main/res/values-night/colors.xml` (dark)
- Test: `signal-sdk/src/test/kotlin/com/beatroute/signal/ThemeResourcesTest.kt`

**Step 1: Port tokens.** Read `design/tokens.css`; transcribe the `--sg-*` palette into `colors.xml` as `signal_orange_500` = `#F78200`, the blue ramp, warm grays, and semantic `signal_success/warning/info/danger` bg+fg. Add `dimens.xml` for radii (`signal_radius_sheet`, `signal_radius_chip`), spacing, and touch target `48dp`. `type.xml` for the type scale. `themes.xml` defines `Theme.Signal` (a `Theme.Material3.*.NoActionBar` descendant) and `ThemeOverlay.Signal.BottomSheet` mapping `colorPrimary` → orange, sheet shape → `signal_radius_sheet`, drag-handle color. `values-night/colors.xml` maps the dark ramp (ink/paper inverted; brand orange stays).

**Step 2: Failing test** (Robolectric resolves resources on the JVM)
```kotlin
@RunWith(RobolectricTestRunner::class)
class ThemeResourcesTest {
  @Test fun `brand orange token is exposed`() {
    val ctx = RuntimeEnvironment.getApplication()
    val c = ctx.getColor(com.beatroute.signal.R.color.signal_orange_500)
    assertEquals(0xFFF78200.toInt(), c)
  }
}
```

**Step 3: Add the resources → green.**

**Step 4: Commit** — `feat(sdk): android theme ported from signal design tokens (light + dark)`

---

### Task A.3: CI job (committed; activation is the user's push)

**Files:**
- Create: `.github/workflows/android.yml`

**Step 1: Workflow**
```yaml
name: Android SDK
on:
  push: { branches: [main], paths: ['sdk-android/**', '.github/workflows/android.yml'] }
  pull_request: { paths: ['sdk-android/**'] }
jobs:
  build:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: sdk-android } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: '17' }
      - uses: android-actions/setup-android@v3
      - run: chmod +x ./gradlew && ./gradlew :signal-sdk:testDebugUnitTest :signal-sdk:assembleRelease
      - uses: actions/upload-artifact@v4
        with: { name: signal-sdk-aar, path: sdk-android/signal-sdk/build/outputs/aar/*.aar }
```

**Step 2: Verify locally** — `./gradlew :signal-sdk:assembleRelease` produces an AAR under `signal-sdk/build/outputs/aar/`.

**Step 3: Commit** — `ci: build and test the android sdk, publish the aar artifact`

**Note (like M0-D11):** activating CI is the user's push; the workflow is committed.

---

## PHASE B — Networking + models (contract-faithful, fail-silent)

### Task B.1: Wire models + fixture-based JSON parsing

**Files:**
- Create: `signal-sdk/src/main/kotlin/com/beatroute/signal/internal/Models.kt`
- Create: `signal-sdk/src/main/kotlin/com/beatroute/signal/internal/Json.kt`
- Test: `signal-sdk/src/test/kotlin/com/beatroute/signal/internal/ModelsTest.kt`
- Fixtures: `signal-sdk/src/test/resources/fixtures/eligibility_config.json`, `error_body.json`

**Step 1: Author fixtures mirroring `packages/contracts`.** `eligibility_config.json` = a real `eligibilityConfigSchema` payload (snake_case: `trigger_id`, `campaign_id`, `metric_type`, `header`, `rating_type`, `rating_scale_max`, `positive_threshold`, `chips_on_negative`, `other_requires_text`, `other_allows_image`, `on_positive_action`, `skip_enabled`). `error_body.json` = `{ "error": { "code": "...", "message": "..." } }`.

**Step 2: Models** — `@Serializable` data classes with `@SerialName` matching the JSON:
```kotlin
@Serializable data class EligibilityConfig(
  @SerialName("trigger_id") val triggerId: String,
  @SerialName("campaign_id") val campaignId: String,
  @SerialName("metric_type") val metricType: String,
  val header: String,
  @SerialName("rating_type") val ratingType: String,       // star | emoji | effort_scale
  @SerialName("rating_scale_max") val ratingScaleMax: Int,
  @SerialName("positive_threshold") val positiveThreshold: Int,
  @SerialName("chips_on_negative") val chipsOnNegative: List<String>,
  @SerialName("other_requires_text") val otherRequiresText: Boolean,
  @SerialName("other_allows_image") val otherAllowsImage: Boolean,
  @SerialName("on_positive_action") val onPositiveAction: String, // none | play_store_review
  @SerialName("skip_enabled") val skipEnabled: Boolean,
)
@Serializable data class ResponseBody(
  @SerialName("trigger_id") val triggerId: String,
  @SerialName("rating_value") val ratingValue: Int,
  @SerialName("chip_selected") val chipSelected: String? = null,
  @SerialName("other_text") val otherText: String? = null,
  @SerialName("other_image_url") val otherImageUrl: String? = null,
  @SerialName("device_os") val deviceOs: String,
  @SerialName("app_version") val appVersion: String,
  @SerialName("rep_tenure_days") val repTenureDays: Int? = null,
  @SerialName("shown_at") val shownAt: String,
  @SerialName("responded_at") val respondedAt: String,
)
@Serializable data class DismissBody(
  @SerialName("trigger_id") val triggerId: String,
  @SerialName("shown_at") val shownAt: String,
  @SerialName("dismissed_at") val dismissedAt: String,
)
```
`Json.kt`: `val SignalJson = Json { ignoreUnknownKeys = true; explicitNulls = false }`.

**Step 3: Failing test** — load `eligibility_config.json` from resources, `SignalJson.decodeFromString<EligibilityConfig>(...)`, assert every field maps; assert `chipsOnNegative.size == 2`. Run → fails (models/Json absent). Implement → green.

**Step 4: Commit** — `feat(sdk): serialization models validated against contract fixtures`

---

### Task B.2: EligibilityClient — fire-and-forget

**Files:**
- Create: `signal-sdk/src/main/kotlin/com/beatroute/signal/internal/EligibilityClient.kt`
- Test: `signal-sdk/src/test/kotlin/com/beatroute/signal/internal/EligibilityClientTest.kt`

**Step 1: Failing tests** (MockWebServer; `RobolectricTestRunner` for Android URL/OkHttp):
1. 200 with `eligibility_config.json` → returns a non-null `EligibilityConfig` with the right `triggerId`
2. 204 → returns `null`
3. 500 → returns `null` (no throw)
4. A response delayed 3s with a client `callTimeout(2s)` → returns `null` (no throw)
5. Malformed JSON body on 200 → returns `null`
6. The request carries the `X-Signal-App-Key` header and the query params `screen_id/user_id/client_id/rep_tenure_days`

**Step 2: Implement**
```kotlin
internal class EligibilityClient(
  private val baseUrl: HttpUrl,
  private val appKey: String,
  private val client: OkHttpClient = OkHttpClient.Builder()
    .callTimeout(2, TimeUnit.SECONDS).build(),
) {
  suspend fun check(
    screenId: String, userId: String, clientId: String, repTenureDays: Int?,
  ): EligibilityConfig? = withContext(Dispatchers.IO) {
    try {
      val url = baseUrl.newBuilder().addPathSegments("v1/sdk/eligibility")
        .addQueryParameter("screen_id", screenId)
        .addQueryParameter("user_id", userId)
        .addQueryParameter("client_id", clientId)
        .apply { if (repTenureDays != null) addQueryParameter("rep_tenure_days", repTenureDays.toString()) }
        .build()
      val req = Request.Builder().url(url).header("X-Signal-App-Key", appKey).get().build()
      client.newCall(req).execute().use { res ->
        if (res.code != 200) return@use null
        val body = res.body?.string() ?: return@use null
        runCatching { SignalJson.decodeFromString<EligibilityConfig>(body) }.getOrNull()
      }
    } catch (_: Throwable) { null } // fire-and-forget: never surface a failure (M3-D7)
  }
}
```

**Step 3: Green. Step 4: Commit** — `feat(sdk): fire-and-forget eligibility client with 2s timeout`

---

### Task B.3: FeedbackClient — result-typed for the outbox

**Files:**
- Create: `.../internal/FeedbackClient.kt`
- Test: `.../internal/FeedbackClientTest.kt`

**Step 1: Failing tests** — `postResponse`/`postDismiss` return a sealed `SendResult`:
1. 204 → `SendResult.Success`
2. 5xx / IOException / timeout → `SendResult.RetryableFailure`
3. 404 (unknown trigger) or 422 → `SendResult.Drop` (permanent; never granted / invalid — don't retry forever)
4. request carries the app key and posts the JSON body

**Step 2: Implement** `sealed interface SendResult { object Success; object RetryableFailure; object Drop }`; POST with `Content-Type: application/json`, classify by status.

**Step 3: Green. Step 4: Commit** — `feat(sdk): feedback client with retryable/drop result classification`

---

## PHASE C — Session, init, local suppression cache

### Task C.1: SessionProvider + Signal.init config

**Files:**
- Create: `.../SessionProvider.kt` (public), `.../internal/SignalConfig.kt`, and the initial `.../Signal.kt`
- Test: `.../SignalInitTest.kt`

**Step 1: Public API**
```kotlin
interface SessionProvider {
  fun userId(): String
  fun clientId(): String
  fun repTenureDays(): Int?    // null when unknown → backend fails closed on tenure-gated campaigns
}
enum class SignalEnvironment(internal val baseUrl: String, internal val appKey: String) {
  STAGING("https://staging.signal.beatroute…/", "STAGING_APP_KEY"),
  PRODUCTION("https://signal.beatroute…/", "PROD_APP_KEY"),
}
```
(Real URLs/keys come from BeatRoute infra — leave as documented placeholders; `Signal.init` also accepts an explicit `baseUrl`/`appKey` override for tests and local dev pointing at `http://10.0.2.2:3000/`.)

**Step 2: Failing tests** — `Signal.init(context, environment, sessionProvider)` stores config; calling a hook before `init` is a silent no-op (never throws); `init` is idempotent.

**Step 3: Implement** `Signal` as an `object` holding a nullable `internal var state: SignalState?` (config + clients + scope). Guard every hook with `val s = state ?: return`.

**Step 4: Green. Step 5: Commit** — `feat(sdk): Signal.init, session provider, environment config`

---

### Task C.2: LocalSuppressionCache (DataStore, 7-day floor)

**Files:**
- Create: `.../internal/LocalSuppressionCache.kt`
- Test: `.../internal/LocalSuppressionCacheTest.kt`

**Step 1: Failing tests** (inject a `Clock` = `() -> Long`; use a temp DataStore file):
1. Unknown `(screenId, clientId)` → `isSuppressed` false
2. After `recordInteraction(screenId, clientId, now)` → `isSuppressed(now + 6 days)` true
3. `isSuppressed(now + 8 days)` false (past the 7-day floor)
4. Different `(screenId, clientId)` is independent

**Step 2: Implement** — persist a `Map<"screenId|clientId", epochMillis>`; `SUPPRESS_FLOOR_MS = 7L*24*3600*1000`; `isSuppressed = now - stored < FLOOR`. Pure logic wrapped around DataStore reads (M3-D9).

**Step 3: Green. Step 4: Commit** — `feat(sdk): local suppression cache with 7-day floor optimization`

---

## PHASE D — Hooks and the dwell timer

### Task D.1: trackEvent wiring (action hook)

**Files:**
- Modify: `.../Signal.kt`
- Create: `.../internal/SheetPresenter.kt` (interface; real impl in Phase E)
- Test: `.../TrackEventTest.kt`

**Step 1: Failing tests** (fakes for `EligibilityClient`, `LocalSuppressionCache`, and a `FakeSheetPresenter`):
1. `trackEvent(screenId)` when locally suppressed → no eligibility call, no sheet
2. Not suppressed, eligibility returns null → no sheet, nothing recorded
3. Not suppressed, eligibility returns a config → `presenter.show(config)` called once
4. Session resolution pulls `userId/clientId/repTenureDays` from the `SessionProvider`
5. Any exception inside the flow never propagates out of `trackEvent`

**Step 2: Implement** — `trackEvent` launches on the SDK scope: resolve session → `cache.isSuppressed` short-circuit → `eligibilityClient.check` → on config `presenter.show(config)`. Wrap in try/catch (M3-D16).

**Step 3: Green. Step 4: Commit** — `feat(sdk): trackEvent action hook with suppression short-circuit`

---

### Task D.2: DwellTimer + screen enter/exit

**Files:**
- Create: `.../internal/DwellTimer.kt`
- Modify: `.../Signal.kt` (`onScreenEnter`/`onScreenExit`)
- Test: `.../DwellTimerTest.kt`

**Step 1: Failing tests** (`kotlinx-coroutines-test`, virtual time):
1. `onScreenEnter` then advance past the dwell threshold (default 3s) → `trackEvent`-equivalent fired once
2. `onScreenExit` before the threshold → timer cancelled, never fired
3. Re-entering restarts the timer
4. Exiting a screen that was never entered is a no-op

**Step 2: Implement** — a per-screen `Job` map; enter launches `delay(DWELL_MS)` then fires the same internal flow as `trackEvent`; exit cancels the job.

**Step 3: Green. Step 4: Commit** — `feat(sdk): dwell-based trigger with coroutine timer cancellation`

---

## PHASE E — The bottom sheet (config-driven, 4 states)

> Visual reference: `prototypes/signal-console-prototype.html` `.preview-col` (stars `.pstar`, emoji `.pemoji`, effort `.peffort`, chips `.pchip`) and `design/tokens.css`. Build natively to the Task A.2 theme.

### Task E.1: Fragment scaffold + drag handle + state machine

**Files:**
- Create: `.../ui/SignalBottomSheetFragment.kt`, `res/layout/signal_sheet.xml`
- Test: `.../ui/SheetScaffoldTest.kt`

**Step 1: Failing tests** (Robolectric, launch the fragment in a `ThemeOverlay.Signal` activity, pass config via `arguments`):
1. Fragment inflates; the header `TextView` shows `config.header`
2. It is a `BottomSheetDialogFragment` with a visible drag handle (`com.google.android.material.bottomsheet` drag handle view present)
3. Initial state = `RATING`

**Step 2: Implement** — `BottomSheetDialogFragment` using the Signal theme overlay; root layout has a `dragHandle`, a header, and a `FrameLayout` state container; an internal `enum State { RATING, POSITIVE, NEGATIVE, OTHER }` with `render(state)`; config parsed from `arguments` (pass the JSON string, decode with `SignalJson`).

**Step 3: Green. Step 4: Commit** — `feat(sdk): bottom sheet fragment scaffold with drag handle and state machine`

---

### Task E.2: Rating widget — star / emoji / effort render modes

**Files:**
- Create: `.../ui/RatingView.kt`, `res/layout/signal_rating_*.xml`, star/emoji drawables
- Test: `.../ui/RatingViewTest.kt`

**Step 1: Failing tests** (Robolectric, drive from config fixtures):
1. `rating_type=star, rating_scale_max=5` → renders 5 star buttons; tapping the 4th reports score 4
2. `rating_type=emoji` → renders 3 emoji buttons (1..3); tapping the happy one reports 3
3. `rating_type=effort_scale, rating_scale_max=3` → renders 3 effort buttons; a `5`-scale config renders 5

**Step 2: Implement** — one `RatingView` with a `render(type, scaleMax)` and an `onScore: (Int) -> Unit`; mirror the prototype's visuals (lit orange stars, rounded emoji tiles, effort segments) using theme tokens and ≥48dp targets.

**Step 3: Green. Step 4: Commit** — `feat(sdk): config-driven rating widget (star/emoji/effort)`

---

### Task E.3: Branch on threshold → positive state

**Files:**
- Modify: `.../ui/SignalBottomSheetFragment.kt`; create `res/layout/signal_state_positive.xml`
- Test: extend `SheetScaffoldTest.kt`

**Step 1: Failing tests**:
1. Score ≥ `positive_threshold` → transitions to `POSITIVE`; thank-you text visible
2. `on_positive_action=play_store_review` → a "Rate us" button is shown and, on tap, fires a Play Store intent (assert the intent action/URI via Robolectric `ShadowActivity.peekNextStartedActivity`)
3. `on_positive_action=none` → no rate button
4. Selecting a positive score enqueues a **response** (see Phase G wiring: for now assert an `onSubmit(ResponseBody)` callback fires with the rating and null chip/text)

**Step 2: Implement** the positive branch + optional deep link.

**Step 3: Green. Step 4: Commit** — `feat(sdk): positive branch with optional play store prompt`

---

### Task E.4: Negative branch — chips + "Other" (text, optional image slot)

**Files:**
- Modify: fragment; create `res/layout/signal_state_negative.xml`, `signal_state_other.xml`
- Test: extend `SheetScaffoldTest.kt`

**Step 1: Failing tests**:
1. Score < threshold → `NEGATIVE`; renders one chip per `chips_on_negative`
2. Tapping a chip then Submit → `onSubmit(ResponseBody)` with `chipSelected` set, `ratingValue` = the score
3. Tapping "Other" → `OTHER` state with a text field; Submit disabled until non-empty (when `other_requires_text`)
4. In `OTHER`, an "Add photo" button is visible only when `other_allows_image` is true (the actual picker/upload is Phase F — here assert visibility + a stubbed `onPickImage` callback)
5. Close/drag-dismiss at any state → `onDismiss()` callback fires

**Step 2: Implement** the negative chip row, the Other sub-branch, and submit assembly. Emit `ResponseBody` (with `shown_at`/`responded_at` from an injected clock) or `DismissBody` to callbacks; wiring to the outbox is Task G.3.

**Step 3: Green. Step 4: Commit** — `feat(sdk): negative branch with chips and other text sub-branch`

---

### Task E.5: Responsive, keyboard, dark, motion, a11y polish

**Files:**
- Modify: layouts, `themes.xml`, fragment
- Test: `.../ui/SheetPolishTest.kt`

**Step 1: Failing/assertable tests** (what Robolectric can check; the rest is a documented manual checklist):
1. The sheet root applies bottom window-insets padding (assert padding > 0 when insets dispatched)
2. Long chip lists scroll (the chip container is inside a scroll view)
3. `values-night` resolves a dark paper color distinct from light (assert via a night-qualified Robolectric config)
4. Rating buttons expose `contentDescription` for TalkBack

**Step 2: Implement** — `WindowInsetsCompat` handling for IME + nav bar; max-height cap with internal scroll; a constrained max width on large screens (`sw600dp` layout qualifier centers the sheet); motion via `MaterialFade`/`TransitionManager` between states; content descriptions; reduced-motion respected via `Settings.Global.ANIMATOR_DURATION_SCALE`.

**Step 3: Add a manual QA checklist** to `sdk-android/README.md` (rotation mid-flow, keyboard overlap, gesture-nav insets, small/large devices, dark mode) — the items Robolectric can't fully cover.

**Step 4: Green. Step 5: Commit** — `feat(sdk): responsive, keyboard-aware, dark-mode, accessible sheet`

---

## PHASE F — Image attach + pre-signed upload

### Task F.1: Image pick + downscale + guardrails

**Files:**
- Create: `.../internal/ImagePicker.kt`, `.../internal/ImageProcessing.kt`
- Test: `.../internal/ImageProcessingTest.kt`

**Step 1: Failing tests** (Robolectric with a bundled test bitmap):
1. A 4000px image is downscaled so the long edge ≤ 1600px
2. Re-encoded JPEG bytes are < 5 MB
3. An unsupported mime → rejected (returns null / error)

**Step 2: Implement** — decode via `BitmapFactory` with `inSampleSize`, re-encode to JPEG quality 85, enforce the size cap (M3-D14). Picker uses `ActivityResultContracts.PickVisualMedia`.

**Step 3: Green. Step 4: Commit** — `feat(sdk): image pick, downscale, and size/type guardrails`

---

### Task F.2: UploadClient — presign then PUT

**Files:**
- Create: `.../internal/UploadClient.kt`
- Modify: `.../ui/SignalBottomSheetFragment.kt` (Other → pick → upload → set `otherImageUrl`)
- Test: `.../internal/UploadClientTest.kt`

**Step 1: Failing tests** (MockWebServer):
1. `upload(bytes, "image/jpeg")` → POSTs `/v1/sdk/uploads` with the app key, gets a ticket, then `PUT`s the bytes to `upload_url` (assert the recorded PUT), and returns `object_url`
2. A failed presign → returns null (image is optional; submit proceeds without it)
3. A failed PUT → returns null

**Step 2: Implement** the two-step flow against the Phase 0 endpoint; wire into the sheet so a picked+uploaded image sets `ResponseBody.otherImageUrl` before submit; show upload progress and a remove affordance.

**Step 3: Green. Step 4: Commit** — `feat(sdk): image upload via pre-signed url wired into the other branch`

---

## PHASE G — The precious outbox

### Task G.1: Room queue (entity + DAO)

**Files:**
- Create: `.../internal/outbox/OutboxEntity.kt`, `OutboxDao.kt`, `OutboxDatabase.kt`
- Modify: `signal-sdk/build.gradle.kts` (switch Room to KSP)
- Test: `.../internal/outbox/OutboxDaoTest.kt`

**Step 1: Failing tests** (Robolectric + in-memory Room):
1. `enqueue(item)` then `pending()` returns it
2. `pending()` orders by `createdAt`
3. `delete(id)` removes it; `incrementAttempts(id)` bumps the count
4. Unique index on `triggerId + kind` prevents a duplicate enqueue (idempotent local enqueue)

**Step 2: Implement** — entity `{ id, kind: 'response'|'dismiss', triggerId, payloadJson, attempts, createdAt }`; DAO; `@Database`. Add KSP plugin + `ksp(room-compiler)`.

**Step 3: Green. Step 4: Commit** — `feat(sdk): room-backed outbox queue`

---

### Task G.2: Flush worker (WorkManager, retry/backoff/idempotency)

**Files:**
- Create: `.../internal/outbox/OutboxWorker.kt`, `.../internal/outbox/Outbox.kt` (enqueue + schedule facade)
- Test: `.../internal/outbox/OutboxWorkerTest.kt`

**Step 1: Failing tests** (`androidx.work:work-testing`, `TestListenableWorkerBuilder`, fake `FeedbackClient`):
1. A queued response, client returns `Success` → worker returns `success()`, row deleted
2. Client returns `RetryableFailure` → worker returns `retry()`, row kept, attempts incremented
3. Client returns `Drop` → worker returns `success()` (consumes it), row deleted (never granted / permanently invalid)
4. Two queued items → both processed in one run
5. Replaying an already-sent `triggerId` is harmless (backend dedups; assert the worker still returns success)

**Step 2: Implement** — worker drains `pending()`, calls the right client method per `kind`, applies the result. `Outbox.enqueueAndSchedule` inserts then enqueues a `OneTimeWorkRequest` constrained to `NetworkType.CONNECTED` with exponential backoff.

**Step 3: Green. Step 4: Commit** — `feat(sdk): outbox flush worker with retry, drop, and idempotent replay`

---

### Task G.3: Wire sheet submit/dismiss → outbox

**Files:**
- Modify: `.../ui/SignalBottomSheetFragment.kt`, `.../internal/SheetPresenter.kt` (real impl), `.../Signal.kt`
- Test: `.../SheetToOutboxTest.kt`

**Step 1: Failing tests**:
1. Submitting the sheet enqueues one `response` outbox row with the assembled `ResponseBody` JSON and schedules the worker; records the local suppression for `(screenId, clientId)`
2. Dismissing enqueues one `dismiss` row and records suppression
3. The real `SheetPresenter.show(config)` displays the fragment on the host's `FragmentManager` (Robolectric)

**Step 2: Implement** — the presenter shows the fragment and bridges its `onSubmit`/`onDismiss` to `Outbox.enqueueAndSchedule` + `cache.recordInteraction`. `device_os`/`app_version` filled from `Build`/host package info; timestamps from the SDK clock.

**Step 3: Green. Step 4: Commit** — `feat(sdk): route sheet submit/dismiss through the precious outbox`

---

## PHASE H — Exit proof

### Task H.1: End-to-end SDK test (MockWebServer, full loop)

**Files:**
- Test: `.../EndToEndTest.kt`

**Step 1: One test scripting the whole loop** against MockWebServer:
1. `Signal.init` pointed at the mock; enqueue an eligibility 200 (config), a response 204
2. `Signal.trackEvent("order_completion")` → the mock receives the eligibility GET with the app key; the presenter shows the sheet
3. Drive the sheet: select a positive score, submit → an outbox row appears
4. Run the outbox worker → the mock receives `POST /v1/sdk/response` with the captured `trigger_id`; row cleared
5. A second immediate `trackEvent` → suppressed locally, no eligibility GET

**Step 2: Green. Step 3: Commit** — `test(sdk): end-to-end trackEvent → sheet → submit → outbox flush`

---

### Task H.2: README + host integration sample

**Files:**
- Create: `sdk-android/README.md`
- Modify: root `README.md` (add an "Android SDK" pointer)

**Step 1:** Document the one-time integration (`Signal.init` in `Application.onCreate`, implement `SessionProvider`), the per-screen action (`Signal.trackEvent`) and dwell (`onScreenEnter/Exit`) hooks, the build/test commands (`./gradlew :signal-sdk:testDebugUnitTest`, `assembleRelease`), the local-backend setup (point `Signal.init` at `http://10.0.2.2:3000`, `docker compose up -d`, seed), and the manual-QA checklist from Task E.5.

**Step 2: Commit** — `docs: android sdk integration and testing guide`

---

### Task H.3: Full verification

**Step 1:** From `sdk-android/`: `./gradlew :signal-sdk:testDebugUnitTest` — all green. `./gradlew :signal-sdk:assembleRelease` — AAR produced. From the repo root: `pnpm verify` — the Phase 0 backend additions are green.

**Step 2 (cross-milestone, manual):** `docker compose up -d`; `pnpm --filter @signal/api db:migrate && seed`; `pnpm --filter @signal/api dev`; run a debug host build (or the E2E test) so a Console-seeded campaign fires through the SDK and lands a real row in `responses` and an image in MinIO.

**Step 3: Commit** (if any doc/version bump) — `chore(sdk): milestone 3 closeout`

---

## Milestone Exit Checklist

- [ ] Prereqs satisfied: M2 merged before Phase 0; cooldown language is `after_*` throughout
- [ ] `./gradlew :signal-sdk:testDebugUnitTest` green on the JVM (no emulator); `assembleRelease` produces an AAR
- [ ] Public surface is exactly `Signal.init / trackEvent / onScreenEnter / onScreenExit`; every hook is a silent no-op before `init` and never throws into the host
- [ ] Eligibility is fire-and-forget (2s timeout, failure shows nothing); `/response` + `/dismiss` go through the Room+WorkManager outbox and survive process death, retried on reconnect, deduped by `trigger_id`
- [ ] Bottom sheet renders all four states from config, with drag handle, responsive/keyboard-aware layout, light + dark, and accessibility labels; visuals match the prototype preview + design tokens
- [ ] Image attach downscales, guards size/type, and uploads to a pre-signed S3/MinIO URL — never inside `/response`
- [ ] `LocalSuppressionCache` short-circuits within the 7-day floor and never suppresses a legitimate ask early
- [ ] End-to-end test proves trackEvent → sheet → submit → outbox → `POST /response`
- [ ] Backend Phase 0: `POST /v1/sdk/uploads` behind app-key auth, MinIO in compose, `pnpm verify` green
- [ ] CI workflow committed for the SDK (activation pending the user's push)
- [ ] Git log: one focused commit per task

**Next:** M4 — full reporting (Reasons/Clients/Responses tabs), BeatRoute client sync, deploy pipeline; then the Console UI last.
```
