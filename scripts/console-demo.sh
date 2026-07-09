#!/usr/bin/env bash
#
# scripts/console-demo.sh — Signal Milestone 2 console exit-proof, cross-milestone
# end-to-end demo. Proves the full loop build→publish→fire→report across M1+M2:
# a PM logs into the Console, registers a target, builds a CSAT campaign as a
# draft, publishes it, and that Console-built campaign then FIRES through the M1
# SDK eligibility engine (`/v1/sdk/eligibility`); a rating is submitted and the
# Console reporting surfaces (`overview`, `dashboard`) reflect it. It also proves
# the overlap 409 guard and pause→204 suppression.
#
# Prints `✅ <label>` for each passing step; on the first mismatch it prints
# `❌ <label> (expected X got Y)` and exits non-zero. Prints
# `ALL CONSOLE SCENARIOS PASSED` at the end.
#
# Requirements: bash, curl, jq. A freshly-seeded DB (re-run `seed` between runs)
# and a running API server with a seeded console admin.
#
# Env:
#   BASE            base URL of the API server (default http://localhost:3000)
#   KEY             X-Signal-App-Key header value for SDK calls (default dev-app-key)
#   ADMIN_EMAIL     seeded console admin email     (required)
#   ADMIN_PASSWORD  seeded console admin password  (required)
#
# The SDK cache auto-refreshes on a 60s timer; to stay deterministic this script
# calls the app-key-guarded POST /v1/sdk/internal/refresh-cache after publish and
# after pause instead of sleeping.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
KEY="${KEY:-dev-app-key}"
ADMIN_EMAIL="${ADMIN_EMAIL:?ADMIN_EMAIL is required}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

# A client the seed guarantees exists; used consistently as the campaign's
# client_id and in the SDK eligibility query.
CLIENT="cl_A"

command -v jq >/dev/null 2>&1 || { echo "❌ jq is required but not installed"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "❌ curl is required but not installed"; exit 1; }

TMPDIR_DEMO="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_DEMO"' EXIT
BODY="$TMPDIR_DEMO/body"
JAR="/tmp/signal-cookies"
rm -f "$JAR"

# Fresh, never-before-used user ids so M1 suppression never interferes.
STAMP="$(date -u +%s)"
USER_FIRE="cdemo_fire_${STAMP}"
USER_PAUSE="cdemo_pause_${STAMP}"

# A per-run target name. Targets persist across runs and the console rejects a
# duplicate screen_id (no auto-suffix, M2-D13), so a unique name keeps the demo
# genuinely re-runnable without hand-clearing the target_registry. The name still
# slugifies to a predictable, asserted screen_id.
TARGET_NAME="Payment Collection ${STAMP}"
EXPECTED_SCREEN_ID="payment_collection_${STAMP}"

# expect_status <expected> <actual> <label>
expect_status() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "✅ $label"
  else
    echo "❌ $label (expected $expected got $actual)"
    echo "   response body:"; cat "$BODY" 2>/dev/null | head -20; echo
    exit 1
  fi
}

# expect_eq <expected> <actual> <label>
expect_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "✅ $label"
  else
    echo "❌ $label (expected '$expected' got '$actual')"
    echo "   response body:"; cat "$BODY" 2>/dev/null | head -20; echo
    exit 1
  fi
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# --- console (cookie-jar) helpers -------------------------------------------
# console_post <path> <json> — sends the session cookie jar, writes body, echoes status.
console_post() {
  curl -s -o "$BODY" -w '%{http_code}' -b "$JAR" \
    -H 'Content-Type: application/json' -X POST "$BASE$1" -d "$2"
}
# console_patch <path> <json>
console_patch() {
  curl -s -o "$BODY" -w '%{http_code}' -b "$JAR" \
    -H 'Content-Type: application/json' -X PATCH "$BASE$1" -d "$2"
}
# console_get <path>
console_get() {
  curl -s -o "$BODY" -w '%{http_code}' -b "$JAR" "$BASE$1"
}
# --- sdk (app-key) helpers ---------------------------------------------------
sdk_get_eligibility() {
  curl -s -o "$BODY" -w '%{http_code}' -H "X-Signal-App-Key: $KEY" \
    "$BASE/v1/sdk/eligibility?$1"
}
sdk_post() {
  curl -s -o "$BODY" -w '%{http_code}' -H "X-Signal-App-Key: $KEY" \
    -H 'Content-Type: application/json' -X POST "$BASE$1" -d "$2"
}
refresh_cache() {
  curl -s -o "$BODY" -w '%{http_code}' -H "X-Signal-App-Key: $KEY" \
    -X POST "$BASE/v1/sdk/internal/refresh-cache"
}

echo "Signal M2 console demo — BASE=$BASE (client=$CLIENT)"
echo

HEADER="How was your payment collection experience?"

# ── Step 1: login with the seeded admin → 200, cookie stored ─────────────────
login_body="$(jq -nc --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p}')"
status="$(curl -s -o "$BODY" -w '%{http_code}' -c "$JAR" \
  -H 'Content-Type: application/json' -X POST "$BASE/v1/console/auth/login" -d "$login_body")"
expect_status 200 "$status" "1. login seeded admin → 200 (cookie stored)"

# ── Step 2: unauthenticated console read (no jar) → 401 ──────────────────────
status="$(curl -s -o "$BODY" -w '%{http_code}' "$BASE/v1/console/campaigns")"
expect_status 401 "$status" "2. GET /v1/console/campaigns with no session → 401"

# ── Step 3: create the "Payment Collection" target → 201, capture screen_id ──
target_body="$(jq -nc --arg n "$TARGET_NAME" '{name:$n, trigger_mechanism:"action"}')"
status="$(console_post "/v1/console/targets" "$target_body")"
expect_status 201 "$status" "3. POST /targets '$TARGET_NAME' → 201"
SCREEN_ID="$(jq -r '.screen_id' "$BODY")"
TARGET_ID="$(jq -r '.id' "$BODY")"
expect_eq "$EXPECTED_SCREEN_ID" "$SCREEN_ID" "3b. screen_id slugified → $EXPECTED_SCREEN_ID"

# ── Step 4: create a draft campaign → capture id ─────────────────────────────
status="$(console_post "/v1/console/campaigns" "$(jq -nc --arg c "$CLIENT" '{client_ids:[$c]}')")"
expect_status 201 "$status" "4. POST /campaigns (draft) → 201"
CAMPAIGN_ID="$(jq -r '.id' "$BODY")"

# ── Step 5: PATCH the draft — full CSAT builder config ───────────────────────
patch_body="$(jq -nc \
  --arg t "$TARGET_ID" --arg c "$CLIENT" --arg h "$HEADER" \
  '{
    target_id:$t,
    client_ids:[$c],
    metric_type:"CSAT",
    rating_type:"star",
    rating_scale_max:5,
    header_text:$h,
    positive_threshold:4,
    chips_on_negative:["Slow to load","Payment failed","Confusing UI"],
    ask_frequency:"after_7_days",
    min_tenure_days:0
  }')"
status="$(console_patch "/v1/console/campaigns/$CAMPAIGN_ID" "$patch_body")"
expect_status 200 "$status" "5. PATCH draft (target/CSAT/star/threshold/chips/freq) → 200"

# ── Step 6: publish the draft → 200 active ───────────────────────────────────
status="$(console_post "/v1/console/campaigns/$CAMPAIGN_ID/publish" "{}")"
expect_status 200 "$status" "6. POST /campaigns/:id/publish → 200"
PUB_STATUS="$(jq -r '.status' "$BODY")"
expect_eq "active" "$PUB_STATUS" "6b. published campaign status == active"

# Force the SDK cache to pick up the newly-published campaign (deterministic).
status="$(refresh_cache)"
expect_status 204 "$status" "6c. POST /v1/sdk/internal/refresh-cache → 204"

# ── Step 7: CROSS-MILESTONE — the Console campaign fires via the M1 engine ───
status="$(sdk_get_eligibility "screen_id=$SCREEN_ID&user_id=$USER_FIRE&client_id=$CLIENT&rep_tenure_days=200")"
expect_status 200 "$status" "7. GET /v1/sdk/eligibility (fresh user) → 200 (Console campaign fires through M1)"
ELIG_HEADER="$(jq -r '.header' "$BODY")"
ELIG_CID="$(jq -r '.campaign_id' "$BODY")"
TRIGGER_ID="$(jq -r '.trigger_id' "$BODY")"
expect_eq "$HEADER" "$ELIG_HEADER" "7b. eligibility header matches Console-built header"
expect_eq "$CAMPAIGN_ID" "$ELIG_CID" "7c. eligibility campaign_id matches the published campaign"
if [[ -z "$TRIGGER_ID" || "$TRIGGER_ID" == "null" ]]; then
  echo "❌ 7d. trigger_id missing from eligibility response"; exit 1
fi
echo "✅ 7d. eligibility returned a trigger_id"

# ── Step 8: submit a positive rating (5) on that trigger → 204 ───────────────
SHOWN="$(now_iso)"; RESP="$(now_iso)"
resp_body="$(jq -nc \
  --arg tid "$TRIGGER_ID" --arg os "android" --arg ver "1.4.0" \
  --arg shown "$SHOWN" --arg responded "$RESP" \
  '{trigger_id:$tid, rating_value:5, device_os:$os, app_version:$ver, shown_at:$shown, responded_at:$responded}')"
status="$(sdk_post "/v1/sdk/response" "$resp_body")"
expect_status 204 "$status" "8. POST /v1/sdk/response (rating 5) → 204"

# ── Step 9: Console Overview reflects the trigger + response ─────────────────
status="$(console_get "/v1/console/campaigns/$CAMPAIGN_ID/overview")"
expect_status 200 "$status" "9. GET /v1/console/campaigns/:id/overview → 200"
OV_TRIGGERS="$(jq -r '.triggers' "$BODY")"
OV_RESPONSES="$(jq -r '.responses' "$BODY")"
OV_SCORE="$(jq -r '.positive_score' "$BODY")"
if [[ "$OV_TRIGGERS" -ge 1 ]]; then echo "✅ 9b. overview triggers >= 1 (got $OV_TRIGGERS)"; else
  echo "❌ 9b. overview triggers (expected >=1 got $OV_TRIGGERS)"; exit 1; fi
expect_eq "1" "$OV_RESPONSES" "9c. overview responses == 1"
expect_eq "1" "$OV_SCORE" "9d. overview positive_score == 1.0 (rating 5 >= threshold 4)"

# ── Step 10: Console dashboard health list contains the campaign ─────────────
status="$(console_get "/v1/console/dashboard")"
expect_status 200 "$status" "10. GET /v1/console/dashboard → 200"
IN_HEALTH="$(jq -r --arg id "$CAMPAIGN_ID" '[.campaigns[] | select(.campaign_id==$id)] | length' "$BODY")"
expect_eq "1" "$IN_HEALTH" "10b. campaign present in dashboard health list"

# ── Step 11: a SECOND overlapping campaign on same target+client → publish 409 ─
status="$(console_post "/v1/console/campaigns" "$(jq -nc --arg c "$CLIENT" '{client_ids:[$c]}')")"
expect_status 201 "$status" "11a. POST /campaigns (second draft) → 201"
CAMPAIGN2_ID="$(jq -r '.id' "$BODY")"
patch2_body="$(jq -nc \
  --arg t "$TARGET_ID" --arg c "$CLIENT" \
  '{
    target_id:$t, client_ids:[$c], metric_type:"CSAT", rating_type:"star",
    rating_scale_max:5, header_text:"Overlapping campaign", positive_threshold:4,
    chips_on_negative:["a","b","c"], ask_frequency:"after_7_days", min_tenure_days:0
  }')"
status="$(console_patch "/v1/console/campaigns/$CAMPAIGN2_ID" "$patch2_body")"
expect_status 200 "$status" "11b. PATCH second draft → 200"
status="$(console_post "/v1/console/campaigns/$CAMPAIGN2_ID/publish" "{}")"
expect_status 409 "$status" "11c. publish overlapping (same target+client) → 409 overlap"

# ── Step 12: pause the first campaign → 200; new user after refresh → 204 ────
status="$(console_post "/v1/console/campaigns/$CAMPAIGN_ID/pause" "{}")"
expect_status 200 "$status" "12a. POST /campaigns/:id/pause → 200"
status="$(refresh_cache)"
expect_status 204 "$status" "12b. refresh-cache after pause → 204"
status="$(sdk_get_eligibility "screen_id=$SCREEN_ID&user_id=$USER_PAUSE&client_id=$CLIENT&rep_tenure_days=200")"
expect_status 204 "$status" "12c. eligibility for a NEW user after pause → 204 (paused campaign no longer fires)"

echo
echo "ALL CONSOLE SCENARIOS PASSED"
