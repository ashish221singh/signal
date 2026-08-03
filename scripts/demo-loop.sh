#!/usr/bin/env bash
#
# scripts/demo-loop.sh — Signal B1 exit-proof end-to-end demo (accounts + tenancy).
#
# Self-contained and re-runnable: it SIGNS UP a fresh account (unique email per
# run) to obtain a real publishable key, builds + publishes a star and an emoji
# campaign through the Console API under that account, then drives the complete
# SDK product loop with that publishable key and asserts the exact HTTP status
# codes for every scenario. Prints `✅ <label>` per step and `ALL SCENARIOS
# PASSED` at the end. On the first mismatch it prints `❌ <label> (expected X got
# Y)` and exits non-zero.
#
# Requirements: bash, curl, jq. A running API server (needs no pre-seed — the
# script provisions its own account). The SDK cache auto-refreshes on a 60s
# timer; to stay deterministic this script calls the key-guarded
# POST /v1/sdk/internal/refresh-cache after publishing instead of sleeping.
#
# Env:
#   BASE  base URL of the API server (default http://localhost:3000)
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"

command -v jq >/dev/null 2>&1 || { echo "❌ jq is required but not installed"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "❌ curl is required but not installed"; exit 1; }

TMPDIR_DEMO="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_DEMO"' EXIT
BODY="$TMPDIR_DEMO/body"
JAR="$TMPDIR_DEMO/cookies"

STAMP="$(date -u +%s)$RANDOM"
EMAIL="demo_${STAMP}@signal.dev"

# expect_status <expected> <actual> <label>
expect_status() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "✅ $label"
  else
    echo "❌ $label (expected $expected got $actual)"
    echo "   response body:"; head -20 "$BODY" 2>/dev/null; echo
    exit 1
  fi
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# --- SDK (publishable-key) helpers ------------------------------------------
get_eligibility() {
  curl -s -o "$BODY" -w '%{http_code}' -H "X-Signal-App-Key: $KEY" \
    "$BASE/v1/sdk/eligibility?$1"
}
post_json() {
  curl -s -o "$BODY" -w '%{http_code}' -H "X-Signal-App-Key: $KEY" \
    -H 'Content-Type: application/json' -X POST "$BASE$1" -d "$2"
}
refresh_cache() {
  curl -s -o "$BODY" -w '%{http_code}' -H "X-Signal-App-Key: $KEY" \
    -X POST "$BASE/v1/sdk/internal/refresh-cache"
}
# --- Console (cookie-jar) helpers -------------------------------------------
console_post() {
  curl -s -o "$BODY" -w '%{http_code}' -b "$JAR" \
    -H 'Content-Type: application/json' -X POST "$BASE$1" -d "$2"
}
console_patch() {
  curl -s -o "$BODY" -w '%{http_code}' -b "$JAR" \
    -H 'Content-Type: application/json' -X PATCH "$BASE$1" -d "$2"
}

echo "Signal B1 demo loop — BASE=$BASE (account $EMAIL)"
echo

# ── Scenario 1: health ───────────────────────────────────────────────────────
status="$(curl -s -o "$BODY" -w '%{http_code}' "$BASE/health")"
expect_status 200 "$status" "1. /health → 200"

# ── Provision: sign up → obtain a real publishable key + a session cookie ────
signup_body="$(jq -nc --arg e "$EMAIL" '{email:$e, password:"demopassword", name:"Demo", account_name:"Demo Co"}')"
status="$(curl -s -o "$BODY" -w '%{http_code}' -c "$JAR" \
  -H 'Content-Type: application/json' -X POST "$BASE/v1/console/auth/signup" -d "$signup_body")"
expect_status 201 "$status" "2. signup → 201 (account + admin + publishable key)"
KEY="$(jq -r '.publishable_key' "$BODY")"
if [[ -z "$KEY" || "$KEY" == "null" ]]; then echo "❌ 2. publishable_key missing"; exit 1; fi
echo "✅ 2b. obtained publishable key ($KEY)"

# ── Provision: auth negatives on the SDK surface ─────────────────────────────
status="$(curl -s -o "$BODY" -w '%{http_code}' \
  "$BASE/v1/sdk/eligibility?screen_id=order_completion&user_id=u_auth")"
expect_status 401 "$status" "3a. eligibility with NO key → 401"
status="$(curl -s -o "$BODY" -w '%{http_code}' -H "X-Signal-App-Key: pk_test_nope" \
  "$BASE/v1/sdk/eligibility?screen_id=order_completion&user_id=u_auth")"
expect_status 401 "$status" "3b. eligibility with an unknown key → 401"

# ── Provision: build a star campaign on order_completion ─────────────────────
target_body='{"name":"Order Completion","trigger_mechanism":"action"}'
status="$(console_post "/v1/console/targets" "$target_body")"
expect_status 201 "$status" "4a. create target order_completion → 201"
SCREEN_STAR="$(jq -r '.screen_id' "$BODY")"
TARGET_STAR="$(jq -r '.id' "$BODY")"

status="$(console_post "/v1/console/campaigns" "{}")"
expect_status 201 "$status" "4b. create draft campaign → 201"
CAMP_STAR="$(jq -r '.id' "$BODY")"
patch_star="$(jq -nc --arg t "$TARGET_STAR" \
  '{target_id:$t, metric_type:"CSAT", rating_type:"star", rating_scale_max:5,
    header_text:"How was placing this order?", positive_threshold:4,
    chips_on_negative:["Slow","Confusing"], ask_frequency:"after_7_days", min_tenure_days:0}')"
status="$(console_patch "/v1/console/campaigns/$CAMP_STAR" "$patch_star")"
expect_status 200 "$status" "4c. patch star campaign complete → 200"
status="$(console_post "/v1/console/campaigns/$CAMP_STAR/publish" "{}")"
expect_status 200 "$status" "4d. publish star campaign → 200 active"

# ── Provision: build an emoji campaign on new_customer_creation ──────────────
status="$(console_post "/v1/console/targets" '{"name":"New Customer Creation","trigger_mechanism":"action"}')"
expect_status 201 "$status" "5a. create target new_customer_creation → 201"
SCREEN_EMOJI="$(jq -r '.screen_id' "$BODY")"
TARGET_EMOJI="$(jq -r '.id' "$BODY")"
status="$(console_post "/v1/console/campaigns" "{}")"
CAMP_EMOJI="$(jq -r '.id' "$BODY")"
patch_emoji="$(jq -nc --arg t "$TARGET_EMOJI" \
  '{target_id:$t, metric_type:"CSAT", rating_type:"emoji", rating_scale_max:3,
    header_text:"How was creating this customer?", positive_threshold:3,
    chips_on_negative:["Confusing"], ask_frequency:"after_7_days", min_tenure_days:90}')"
status="$(console_patch "/v1/console/campaigns/$CAMP_EMOJI" "$patch_emoji")"
expect_status 200 "$status" "5b. patch emoji campaign complete → 200"
status="$(console_post "/v1/console/campaigns/$CAMP_EMOJI/publish" "{}")"
expect_status 200 "$status" "5c. publish emoji campaign → 200 active"

# Force the SDK cache to see both freshly-published campaigns.
status="$(refresh_cache)"
expect_status 204 "$status" "5d. refresh SDK cache → 204"

# ── Scenario 6: grant on the star campaign ───────────────────────────────────
status="$(get_eligibility "screen_id=$SCREEN_STAR&user_id=u_demo_1&rep_tenure_days=200")"
expect_status 200 "$status" "6. grant u_demo_1 on $SCREEN_STAR → 200"
TRIGGER_1="$(jq -r '.trigger_id' "$BODY")"
RATING_TYPE_1="$(jq -r '.rating_type' "$BODY")"
[[ "$RATING_TYPE_1" == "star" ]] && echo "✅ 6b. rating_type == star" || { echo "❌ 6b. rating_type (got $RATING_TYPE_1)"; exit 1; }

# ── Scenario 7: debounce / suppress (immediate repeat) ───────────────────────
status="$(get_eligibility "screen_id=$SCREEN_STAR&user_id=u_demo_1&rep_tenure_days=200")"
expect_status 204 "$status" "7. immediate repeat for u_demo_1 → 204 (suppressed)"

# ── Scenario 8: respond + idempotent replay + never re-ask ───────────────────
SHOWN="$(now_iso)"; RESP="$(now_iso)"
resp_body_1="$(jq -nc --arg tid "$TRIGGER_1" --arg shown "$SHOWN" --arg responded "$RESP" \
  '{trigger_id:$tid, rating_value:5, device_os:"android", app_version:"1.2.3", shown_at:$shown, responded_at:$responded}')"
status="$(post_json "/v1/sdk/response" "$resp_body_1")"
expect_status 204 "$status" "8a. respond rating_value=5 → 204"
status="$(post_json "/v1/sdk/response" "$resp_body_1")"
expect_status 204 "$status" "8b. idempotent replay → 204"
status="$(get_eligibility "screen_id=$SCREEN_STAR&user_id=u_demo_1&rep_tenure_days=200")"
expect_status 204 "$status" "8c. eligibility after submit → 204 (never re-ask)"

# ── Scenario 9: dismiss path ─────────────────────────────────────────────────
status="$(get_eligibility "screen_id=$SCREEN_STAR&user_id=u_demo_2&rep_tenure_days=200")"
expect_status 200 "$status" "9a. grant u_demo_2 → 200"
TRIGGER_2="$(jq -r '.trigger_id' "$BODY")"
dismiss_body_2="$(jq -nc --arg tid "$TRIGGER_2" --arg shown "$(now_iso)" --arg dismissed "$(now_iso)" \
  '{trigger_id:$tid, shown_at:$shown, dismissed_at:$dismissed}')"
status="$(post_json "/v1/sdk/dismiss" "$dismiss_body_2")"
expect_status 204 "$status" "9b. dismiss u_demo_2 trigger → 204"
status="$(get_eligibility "screen_id=$SCREEN_STAR&user_id=u_demo_2&rep_tenure_days=200")"
expect_status 204 "$status" "9c. eligibility after dismiss → 204 (7-day cooldown)"

# ── Scenario 10: validation (emoji bounds 1..3) ──────────────────────────────
status="$(get_eligibility "screen_id=$SCREEN_EMOJI&user_id=u_demo_3&rep_tenure_days=200")"
expect_status 200 "$status" "10a. grant u_demo_3 on $SCREEN_EMOJI (emoji) → 200"
TRIGGER_3="$(jq -r '.trigger_id' "$BODY")"
resp_body_3_bad="$(jq -nc --arg tid "$TRIGGER_3" --arg shown "$(now_iso)" --arg responded "$(now_iso)" \
  '{trigger_id:$tid, rating_value:4, device_os:"ios", app_version:"2.0.0", shown_at:$shown, responded_at:$responded}')"
status="$(post_json "/v1/sdk/response" "$resp_body_3_bad")"
expect_status 422 "$status" "10b. respond rating_value=4 (emoji) → 422 invalid_rating"
resp_body_3_ok="$(jq -nc --arg tid "$TRIGGER_3" --arg shown "$(now_iso)" --arg responded "$(now_iso)" \
  '{trigger_id:$tid, rating_value:3, device_os:"ios", app_version:"2.0.0", shown_at:$shown, responded_at:$responded}')"
status="$(post_json "/v1/sdk/response" "$resp_body_3_ok")"
expect_status 204 "$status" "10c. respond rating_value=3 on same trigger → 204"

# ── Scenario 11: tenure gate on the emoji campaign (min_tenure_days=90) ───────
status="$(get_eligibility "screen_id=$SCREEN_EMOJI&user_id=u_demo_4&rep_tenure_days=30")"
expect_status 204 "$status" "11a. u_demo_4 tenure 30 → 204 (under 90)"
status="$(get_eligibility "screen_id=$SCREEN_EMOJI&user_id=u_demo_4&rep_tenure_days=120")"
expect_status 200 "$status" "11b. u_demo_4 tenure 120 → 200"
status="$(get_eligibility "screen_id=$SCREEN_EMOJI&user_id=u_demo_5")"
expect_status 204 "$status" "11c. u_demo_5 no tenure param → 204 (fail-closed)"

# ── Scenario 12: race (two parallel eligibility calls) ───────────────────────
race_q="screen_id=$SCREEN_STAR&user_id=u_demo_7&rep_tenure_days=200"
s_a="$TMPDIR_DEMO/race_a"; s_b="$TMPDIR_DEMO/race_b"
curl -s -o /dev/null -w '%{http_code}' -H "X-Signal-App-Key: $KEY" "$BASE/v1/sdk/eligibility?$race_q" > "$s_a" &
pid_a=$!
curl -s -o /dev/null -w '%{http_code}' -H "X-Signal-App-Key: $KEY" "$BASE/v1/sdk/eligibility?$race_q" > "$s_b" &
pid_b=$!
wait "$pid_a"; wait "$pid_b"
status_a="$(cat "$s_a")"; status_b="$(cat "$s_b")"
if { [[ "$status_a" == "200" && "$status_b" == "204" ]] || [[ "$status_a" == "204" && "$status_b" == "200" ]]; }; then
  echo "✅ 12. race u_demo_7 → exactly one 200 and one 204 (got $status_a / $status_b)"
else
  echo "❌ 12. race u_demo_7 (expected one 200 + one 204 got $status_a / $status_b)"; exit 1
fi

echo
echo "ALL SCENARIOS PASSED"
