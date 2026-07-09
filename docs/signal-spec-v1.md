# Signal — In-App CSAT/CES Feedback System
### Product & Technical Spec — v1.2

> v1.2 (2026-07-09): cooldown options remodeled to after_7_days | after_30_days | after_60_days (replacing once_per_week | once_per_day | no_cooldown); daily_cap removed (a 7-day minimum makes a per-24h cap unreachable); the no-cooldown debounce is gone (the ≥7-day cooldown protects the double-trigger race for free).
> v1.1 (2026-07-08): eligibility carries rep_tenure_days; trigger_id introduced as the response/dismiss idempotency key; one-active-campaign-per-(target,client) rule; ratings/thresholds normalized to integers.

---

## 1. Why We're Building This

Every rupee of BeatRoute's recurring revenue depends on rep experience. If a rep finds the app frustrating, they enter data poorly or not at all. Poor data erodes manager trust. Loss of manager trust leads to client churn.

Rep experience is a business continuity problem, not just a UX nicety — so we need structured, continuous feedback at the moments that matter, rather than relying on ad hoc complaints or support tickets.

**Goal:** Make BeatRoute the app reps *choose* to open, by finding every point of friction, fixing it fast, and proving to reps that their feedback changes something — measured via CSAT/CES trending up, activity by activity, month over month.

**Why not NPS:** NPS measures long-term loyalty and fits someone like a manager or client owner reflecting at a desk. It doesn't fit a field rep standing in a shop, mid-transaction, on unstable 4G, with one hand full of goods. We ask task-level CSAT/CES instead — quick, one-tap, contextual to what they just did.

**Core design principle:** every feedback ask must work for someone standing in a shop with a time constraint. No open text walls, no multi-page surveys. One tap by default; text is optional and only surfaced when something's actually wrong.

---

## 2. What "Signal" Is

Signal is one system, three parts, one name:

| Part | What it is |
|---|---|
| **Signal Console** | Internal admin tool where a PM builds and manages feedback campaigns — no engineering involvement after initial setup |
| **Signal Backend** | New standalone service: campaign config, eligibility logic, suppression state, response storage, reporting |
| **Signal SDK** | Android library (`com.beatroute:signal-sdk`) — bottom sheet UI + trigger hooks + networking, integrated once into the Route app |

The system is designed so that **running feedback campaigns is pure configuration** after a one-time engineering integration per screen. New campaigns, new questions, new targeting, pausing/resuming — none of it requires a new app release. Only wiring up a brand-new screen for the first time does.

---

## 3. Metric Model

Two metric types, chosen per campaign:

- **CSAT** (Customer Satisfaction) — 5-star, or 3-emoji (😊 😐 😞)
- **CES** (Customer Effort Score) — effort scale (Easy / OK / Hard, or 1–5)

**Scoring formula (not an average):**

```
Score = (count of positive responses) / (total responses)
```

"Positive" is threshold-defined **per campaign** — e.g. 4★+5★ count as positive, 1–3 don't; or only 😊 counts, 😐/😞 don't. This must be configurable, not hardcoded, since different campaigns may want a stricter or looser bar.

All rating values and positive thresholds are integers: star 1–5, emoji 1–3 (3 = 😊), effort 1–3 or 1–5. "Only 😊 counts" is expressed as positive_threshold = 3.

---

## 4. Trigger Model — Exactly Two Mechanisms

### 4.1 Action-based trigger
Fires once, at the exact moment a specific action completes successfully. It is tied to the **completion event**, not to any resulting screen.

> Example: Order placed successfully → fires. Later, opening that same order (or any other existing order) just to view it → does **not** fire, because the view screen's lifecycle is separate from the placement action's success path.

Examples of action-based workflows: order creation, payment collection, customer creation, stock update, visit scheduling, custom form submission.

### 4.2 Dwell-based trigger
Fires if a user remains on a specific screen longer than a configured threshold (e.g. 10–15 seconds), regardless of how they arrived or whether anything was "completed." Tied to screen lifecycle (`onResume`/`onPause` or equivalent).

Examples of dwell-based screens: goal monitoring, reports, other monitoring-only pages.

**This distinction must be explicit in the target registry** (see §7.1) — the two trigger types are wired into completely different parts of the Android codebase, and conflating them creates exactly the false-trigger bug this design avoids (e.g. firing NPS on someone just viewing an old order).

---

## 5. Bottom Sheet — Branching Logic

The Signal SDK ships **one** native bottom sheet component, built once, whose content and branching are entirely driven by campaign config — never hardcoded per campaign.

```
Header (config-driven text)
Rating input (star / emoji / effort-scale — config-driven)
        │
        ▼
Score >= positive_threshold?
        │
   ┌────┴─────┐
  YES          NO
   │            │
   ▼            ▼
Thank-you    Chip row (config-driven reasons)
message          │
   │        ┌────┴─────┐
   ▼      chip       "Other"
Optional   selected      │
Play Store    │          ▼
review      Submit   Mandatory text input
prompt                + optional image attach
                            │
                            ▼
                          Submit

[Close/Skip always available, at any state]
```

**View states required (fixed, built once):**
1. Rating input (star / emoji / effort — same component, different render mode)
2. Positive branch — thank-you + optional external deep link
3. Negative branch — chip selection
4. "Other" sub-branch — text input + optional image picker

---

## 6. Suppression & Frequency Rules

Per-campaign, not a single global rule (real-world variation confirmed from prior campaign planning: a high-touch order-placement survey re-asks after 7 days; lower-frequency surveys re-ask after 30 or 60 days; some campaigns additionally gate to reps past a tenure threshold).

```
Campaign.ask_frequency   = after_7_days | after_30_days | after_60_days
Campaign.min_tenure_days = integer (optional — gates campaign for new reps)
```

Cooldowns are rolling windows measured from `last_shown_at`: `after_7_days` = 168h, `after_30_days` = 720h, `after_60_days` = 1440h. The minimum 7-day window also makes the double-trigger race harmless (a provisional suppression row is always ≥7 days out), so no separate debounce is needed.

**Fixed behavioral rules (not campaign-configurable, always true):**
- Dismissed → suppressed per `ask_frequency` cooldown, for that campaign specifically
- Submitted → never asked again for that campaign (unless a future need for periodic re-ask is explicitly added)
- At most one active campaign may exist per (target, client) pair. The Console enforces this at publish; the backend tie-breaks deterministically (oldest active campaign wins) as defense in depth.

Suppression is tracked **per (user_id, campaign_id)** — not globally across all campaigns — so a user can be asked about a different workflow in the same week even if they just answered another campaign's ask.

---

## 7. Data Model

### 7.1 Target Registry
Static list, manually maintained (source of truth shared between Signal Console and Android engineering — not auto-discovered).

```
TargetRegistry
- id
- name                  (human label, e.g. "Order Completion")
- screen_id             (slugified, auto-generated from name, e.g. "order_completion")
- trigger_mechanism     (action | dwell)
- integration_status    (not_sent | sent_to_engineering | confirmed_live)
```

### 7.2 Campaign
```
Campaign
- id
- client_ids[]          (which of the client base this campaign targets)
- target_id             (FK -> TargetRegistry)
- metric_type           (CSAT | CES)
- rating_type           (star | emoji | effort_scale)
- header_text           (editable question text)
- positive_threshold    (e.g. 4, or "happy_emoji_only")
- chips_on_negative[]   (preset reason strings)
- other_requires_text   (boolean, default true)
- other_allows_image    (boolean)
- on_positive_action    (none | play_store_review)
- ask_frequency         (after_7_days | after_30_days | after_60_days)
- min_tenure_days       (int, optional)
- status                (draft | active | paused)
- created_by, created_at, updated_at
```

### 7.3 SuppressionState
```
SuppressionState
- user_id
- campaign_id
- last_shown_at
- last_action           (dismissed | submitted | null)
- next_eligible_at       (null = never show again)
```

### 7.4 TriggerLog
Every time a bottom sheet was actually shown — powers "Total Triggers" / "Unique Users Reached" independent of whether they answered.
```
TriggerLog
- id, campaign_id, user_id, client_id, screen_id, shown_at
```

### 7.5 Response
```
Response
- id
- trigger_id              (FK -> TriggerLog; idempotency key for /response)
- campaign_id, user_id, client_id, screen_id
- rating_value
- chip_selected          (nullable)
- other_text             (nullable)
- other_image_url        (nullable)
- location {lat, lng, state, country}
- device_os, app_version
- rep_tenure_days
- shown_at, responded_at
```

### 7.6 Client
Read-only cache synced from BeatRoute's existing client list API — the only real data dependency on the core BeatRoute product.
```
Client
- id, name, status (active | inactive)
- last_synced_at
```

**How this cache gets populated — needs to be confirmed with the BeatRoute core backend team, but the intended mechanism:**

1. **Source:** BeatRoute's existing super-admin client data (the same client/client-level data structure referenced earlier in this process) — Signal does not become a second source of truth for client data, it only mirrors it.
2. **Access:** Signal backend needs a **service-to-service credential** (API key or internal auth token) issued by whoever owns BeatRoute's core backend, scoped to read-only access on the client list endpoint. This is an internal call, not public API — needs to be provisioned once, coordinated with backend/infra.
3. **Sync method (recommended for v1): scheduled pull, not real-time push.**
   - A scheduled job (e.g. nightly, or hourly if that's cheap) on the Signal backend calls BeatRoute's client list API and upserts into Signal's local `Client` table (insert new clients, update names/status, never delete — just mark inactive if removed from source)
   - This is sufficient because the Signal Console's client picker doesn't need second-by-second accuracy — a client added this morning being visible in Signal by tonight's sync is an acceptable gap for v1
   - A push-based approach (BeatRoute emits a webhook/event on client create/update) is a valid future upgrade if fresher data becomes necessary, but adds coordination overhead (BeatRoute's team must own emitting the event) that isn't justified for v1
4. **Fields required from the source API:** at minimum `client_id`, `name`, and `status` (active/inactive) — status matters so the campaign builder doesn't let someone target a churned/inactive client by mistake. Confirm with backend whether this is already exposed or needs adding to the existing client API response.
5. **Failure handling:** if a sync run fails (API down, timeout, auth error), Signal Console continues serving its last successfully cached client list rather than blocking the campaign builder — log the failure and alert, don't hard-fail the UI.

**Open item to resolve with BeatRoute backend/infra before build starts:** confirm the exact existing endpoint (or whether a new one needs to be exposed), the auth mechanism for service-to-service calls, and expected response shape/fields.

**Auth approach (v1): OAuth2 client credentials flow**, since BeatRoute's auth infrastructure already supports it — use it rather than introducing a separate static-key pattern.

**Registration (one-time, coordinated with BeatRoute's team):**
```
client_id: signal-backend
client_secret: <issued by BeatRoute>
scope: clients:read     (narrow, read-only — not a broad/admin scope)
grant_type: client_credentials
```

**Token acquisition, before each sync run:**
```
POST https://auth.beatroute.com/oauth/token
Body: grant_type=client_credentials, client_id, client_secret, scope=clients:read

Response: { "access_token": "...", "token_type": "Bearer", "expires_in": 3600 }
```

**Client-list call using the token:**
```
GET https://internal-api.beatroute.com/v1/clients
Authorization: Bearer <access_token>
```

**Caching:** cache the token for its `expires_in` window (with a small refresh buffer, e.g. re-fetch 5 min before expiry) rather than requesting a new token on every call — though given the sync only runs nightly/hourly, a fresh token per run is likely simplest and still cheap.

**Secret storage:** `client_secret` lives in a secrets manager (AWS/GCP Secrets Manager, Vault, etc.), never hardcoded or committed to source, accessible only to the sync job's runtime.

**Failure handling:** if token acquisition or the API call fails, retry with backoff, log clearly which step failed, alert the team same-day, and leave the existing `Client` cache untouched rather than wiping it.

**Concrete asks for BeatRoute engineering (OAuth2-specific):**
1. Register `signal-backend` as a client_credentials client
2. Issue `client_id` + `client_secret`, scoped to `clients:read` only
3. Confirm the token endpoint URL and token lifetime (`expires_in`)
4. Confirm the client-list API's exact response shape (does it include `status`?)
5. Confirm whether secret rotation supports a dual-valid overlap window (issue new secret, both valid briefly, retire old) rather than a hard cutover

---

## 8. API Contracts

Standalone service, its own deploy, independent of BeatRoute's core API surface.

### 8.1 `GET /eligibility`
Called by the SDK the moment a hook fires.

**Request (query params):**
```
screen_id, user_id, client_id, rep_tenure_days (optional int — supplied by the SDK from the app session; if absent and the campaign sets min_tenure_days, the user is not eligible)
```

**Logic:**
1. Find active `Campaign` matching `client_id` (in `client_ids[]`) + `target_id` (via `screen_id`)
2. Check `SuppressionState` for `(user_id, campaign_id)` — is `next_eligible_at` null or in the past?
3. Check `min_tenure_days` if set, against rep's tenure
4. If eligible → write a `TriggerLog` row, return campaign config
5. If not eligible → return empty/204

**Response (200, eligible):**
```json
{
  "trigger_id": "tl_9f2…",
  "campaign_id": "c_123",
  "metric_type": "CSAT",
  "header": "How satisfied were you with placing this order?",
  "rating_type": "star",
  "positive_threshold": 4,
  "chips_on_negative": ["Slow to load", "Items hard to find", "Sync failed"],
  "other_requires_text": true,
  "other_allows_image": true,
  "on_positive_action": "play_store_review",
  "skip_enabled": true
}
```

`trigger_id`: server-generated ID of the TriggerLog row; the SDK must echo it in /response or /dismiss.

**Response (204, not eligible):** empty body.

### 8.2 `POST /response`
Called when the user submits a rating/answer.

**Request:**
```json
{
  "trigger_id": "tl_9f2…",
  "campaign_id": "c_123",
  "screen_id": "order_completion",
  "user_id": "u_5567",
  "client_id": "cl_A",
  "rating_value": 4,
  "chip_selected": null,
  "other_text": null,
  "other_image_url": null,
  "location": { "lat": 30.9, "lng": 75.8, "state": "Punjab", "country": "IN" },
  "device_os": "Android",
  "app_version": "4.12.0",
  "rep_tenure_days": 210,
  "shown_at": "2026-07-07T10:12:00Z",
  "responded_at": "2026-07-07T10:12:18Z"
}
```

Note: `(campaign_id, user_id, shown_at)` is no longer the idempotency key — `trigger_id` is.

**Backend actions:**
- Insert `Response` row
- Update `SuppressionState`: `last_action = submitted`, `next_eligible_at = null` (or per future re-ask policy)

### 8.3 `POST /dismiss`
Called when the user closes the sheet without answering.

**Request:**
```json
{
  "trigger_id": "tl_9f2…",
  "campaign_id": "c_123",
  "screen_id": "order_completion",
  "user_id": "u_5567",
  "client_id": "cl_A",
  "shown_at": "2026-07-07T10:12:00Z",
  "dismissed_at": "2026-07-07T10:12:03Z"
}
```

Note: `(campaign_id, user_id, shown_at)` is no longer the idempotency key — `trigger_id` is.

**Backend actions:**
- Update `SuppressionState`: `last_action = dismissed`, `next_eligible_at = now + cooldown` (per campaign's `ask_frequency`)

### 8.4 Internal endpoints (Signal Console only, not called by Android)
```
GET/POST/PUT /campaigns
GET          /clients                  (proxied/cached from BeatRoute)
GET          /reporting/{campaign_id}
GET          /reporting/{campaign_id}/responses?filter=...
```

---

## 9. Signal SDK (Android)

### 9.1 What ships inside the SDK
- Native bottom sheet component (all 4 view states from §5)
- Hook functions (public API surface, see below)
- Networking client (calls the 3 APIs internally)
- Local suppression-state cache (fast path, synced periodically with backend)
- Session hook — SDK holds a reference to the app's existing session/auth manager so `user_id`/`client_id` never need to be passed manually per call

### 9.2 Public API surface (what Android engineering actually touches)

**One-time integration (added once, ever):**
```gradle
// build.gradle
implementation("com.beatroute:signal-sdk:1.0.0")
```
```kotlin
// Application.onCreate()
Signal.init(context = applicationContext, sessionProvider = SessionManager)
```

**Per new action-based screen (added once per screen):**
```kotlin
fun onOrderPlacedSuccessfully(orderId: String) {
    Signal.trackEvent(screenId = "order_completion")   // <-- added here, only here
    navigateToOrderViewScreen(orderId)
}
```

**Per new dwell-based screen (added once per screen):**
```kotlin
override fun onResume() {
    super.onResume()
    Signal.onScreenEnter(screenId = "goal_monitoring_page")
}
override fun onPause() {
    Signal.onScreenExit(screenId = "goal_monitoring_page")
    super.onPause()
}
```

### 9.3 Internal flow triggered by a hook call
```
Signal.trackEvent(screenId) called
   → SDK internally resolves user_id/client_id from session
   → SDK calls GET /eligibility(screen_id, user_id, client_id)
   → if response has config: instantiate SignalBottomSheetFragment(config), show it
   → if empty: no-op, nothing shown

User interacts with sheet:
   → Submit  → SDK calls POST /response(...)
   → Dismiss → SDK calls POST /dismiss(...)
```

### 9.4 Snippet generation (Signal Console feature)
When a campaign targets a screen with `integration_status = not_sent`, the Console auto-generates:
- The correct snippet (action or dwell template, per §9.2), with `screen_id` pre-filled (slugified from the campaign's target name — never manually typed by engineering, to avoid ID mismatches)
- A one-line explanation of trigger meaning and explicit placement guidance (e.g. "place in the success handler, NOT in the resulting view screen's lifecycle")
- Campaign stays in **Draft** status until manually marked `confirmed_live`

---

## 10. Reporting

### 10.1 Per-activity dashboard
- Rolling 30-day % positive score + trend line
- Total triggers, unique users reached, response rate (responded ÷ triggered)
- Bar chart comparing all activities' current 30-day score side by side

### 10.2 Chip ranking view
Ranked list of chip selections per activity — surfaces the top complaint reasons, supports a weekly rhythm of: review top-3 chips → if a chip stays top-3 two weeks running, raise it as an engineering ticket manually (no automation in v1).

### 10.3 Client breakdown
Same metrics (triggers, response rate, avg score) split by client — since one campaign can span multiple clients and an aggregate can hide one underperforming client.

### 10.4 Drill-down
Raw response feed, filterable by score range — primary use case is filtering to low scores + reading comments to find the "why" behind a number.

### 10.5 Explicitly deferred to a later version
- Automated threshold alerting (do this manually first, in the weekly review, before automating)
- Segment cuts by device/region/manager-team (start with client-level only; add once real usage surfaces which cuts actually matter)
- Any LLM-based comment classification, ticket drafting, or anomaly narration

---

## 11. V1 Scope

**In:**
- CSAT + CES metric types
- Action-based and dwell-based triggers
- Branching bottom sheet (positive → thank-you/Play Store; negative → chips → other/text/image)
- Per-campaign frequency/cooldown rules
- Reporting: per-activity trend, chip ranking, client breakdown, drill-down

**Out (deliberately deferred):**
- LLM/agentic layer of any kind
- Automated alerting
- Multi-dimension segment reporting beyond client
- Multi-app reuse (design for it, don't build a second integration yet)

**Rollout approach:** instrument 2–3 highest-signal screens first (order completion is the natural first pick), run for ~2 weeks on one client, validate the full loop end to end (trigger accuracy, suppression correctness, chip relevance, reporting numbers reconciling against raw data) before instrumenting the rest of the target list.

---

## 12. Build Sequence

1. **Agree the API contract** (§8) between backend and Android teams — this is the one shared artifact both sides build against; lock it first.
2. **Backend team**, in parallel:
   - Build data model (§7)
   - Build `/eligibility`, `/response`, `/dismiss`
   - Build campaign CRUD + client proxy for the Console
3. **Android team**, in parallel (can mock `/eligibility` responses until backend is ready):
   - Build `signal-sdk` module: bottom sheet (4 states), hook functions, networking client, session integration
4. **Integration test** — wire both together against one real screen (order completion), one client, before wider rollout
5. **Signal Console UI** — build the campaign builder (client picker → target picker → trigger config → content config → publish) once the eligibility/response loop is confirmed working
6. **Reporting dashboard** — build last, once real response data exists to validate against

---

## 13. Open Decisions (flag before/during build)

- Confirm whether `min_tenure_days` gating should apply retroactively to already-tenured reps or only affect new campaigns going forward
- Confirm image storage location/provider for `other_image_url` uploads (S3-equivalent, retention policy)
- Confirm Play Store deep link mechanism (package name, review flow entry point) with whoever owns the Play Console listing
- Decide whether Signal SDK is hosted in-repo (simpler now) or as a versioned artifact in an internal Maven/Artifactory repo (cleaner for future multi-app reuse) — recommend the latter if a second app is reasonably likely within 12 months
- Confirm the exact cooldown default values per trigger category (weekly/daily/no-cooldown) against the original activity table before first campaigns go live
- Confirm with BeatRoute backend/infra: the exact client-list API endpoint Signal will pull from, the service-to-service auth mechanism, whether `status` (active/inactive) is already in the response, and agreed sync frequency (§7.6)

---

## 14. Implementation Handoff Notes (for Claude Code / build execution)

This spec is meant to be handed directly to Claude Code (or an engineering team) to scaffold. A few things worth being explicit about at handoff time, so the build doesn't stall or silently hardcode placeholder values as if they were real.

### 14.1 What can be fully built from this spec alone
- Signal backend: data model (§7), all three APIs (§8), campaign CRUD, reporting endpoints
- Signal SDK: bottom sheet (all 4 states), hook functions, networking client, local suppression cache, session integration
- The OAuth2 client-credentials flow logic itself (token request, caching with expiry buffer, refresh, retry-with-backoff, failure logging) — see §7.6
- Signal Console UI: campaign builder, reporting dashboard

### 14.2 What must come from BeatRoute engineering before this can run for real (not something code alone can produce)
- Actual `client_id` / `client_secret` for Signal's OAuth2 registration
- Actual token endpoint URL and client-list API URL
- Actual response shape of the client-list API (confirm field names, especially `status`)
- Confirmation of whether secret rotation supports a dual-valid overlap window

**Instruction to give Claude Code explicitly at build start:** *"Use placeholder environment variables for BeatRoute's OAuth credentials, token endpoint, and client-list API URL (e.g. `BEATROUTE_CLIENT_ID`, `BEATROUTE_CLIENT_SECRET`, `BEATROUTE_TOKEN_URL`, `BEATROUTE_CLIENTS_API_URL`) — real values will be supplied once BeatRoute engineering issues them. Don't stall the rest of the build waiting on these, and don't hardcode anything that looks like a real credential or URL."*

### 14.3 What requires manual testing against BeatRoute's real (or staging) environment, not just code review
- The full OAuth2 token flow, run against BeatRoute's actual auth service
- The client-list sync job, run against BeatRoute's actual API, to confirm the response shape assumed in §7.6 matches reality (adjust field mapping if not)
- End-to-end integration test on one real screen (order completion) against one real client, per the rollout approach in §11

### 14.4 Infra/DevOps tasks outside of pure code (need a person, not just Claude Code)
- Provisioning a secrets manager (or confirming which one Signal's infra already uses) and storing the real `client_secret` there once issued
- Setting up the scheduled job runner for the nightly/hourly client sync (cron, cloud scheduler, etc.)
- Setting up image storage for `other_image_url` uploads (§13)
- Coordinating the Play Store deep link mechanism with whoever owns the Play Console listing (§13)

### 14.5 Suggested first Claude Code build order
1. Data model + migrations (§7)
2. `/eligibility`, `/response`, `/dismiss` endpoints (§8), with unit tests using mocked data
3. OAuth2 + client-sync job (§7.6), using placeholder env vars, with unit tests mocking the token/API responses
4. Signal SDK module skeleton (bottom sheet states, hooks, networking client) — can be built and tested in isolation before backend is fully live, using mocked `/eligibility` responses
5. Signal Console (campaign builder + reporting), once the core APIs are stable
6. Wire everything together, then swap placeholder env vars for real BeatRoute credentials once issued, and run the manual integration tests from §14.3

---

## Appendix: Naming Reference
- **Signal** — the system as a whole (console, backend, SDK)
- `com.beatroute:signal-sdk` — the Android library artifact name
- No separate "agent" branding — Signal is the single name used everywhere, internally and in any documentation
