#!/usr/bin/env bash
#
# scripts/demo-loop.sh — Signal Milestone 1 exit-proof end-to-end demo.
#
# Drives the complete product loop against a running API server and asserts the
# exact HTTP status codes for every scenario in the spec. Prints `✅ <label>`
# for each passing step and `ALL SCENARIOS PASSED` at the end. On the first
# mismatch it prints `❌ <label> (expected X got Y)` and exits non-zero.
#
# Requirements: bash, curl, jq. A freshly-seeded DB (re-run `seed` between runs)
# and the server started with SIGNAL_NO_COOLDOWN_DEBOUNCE_SECONDS=2 so the
# no_cooldown debounce is 2s (needed for the daily-cap scenario).
#
# Env:
#   BASE  base URL of the API server (default http://localhost:3000)
#   KEY   value for the X-Signal-App-Key header (default dev-app-key)
#
# Note: suppression persists in the DB, so this script is only guaranteed green
# on a freshly-seeded DB with the u_demo_1..u_demo_7 user ids never used before.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
KEY="${KEY:-dev-app-key}"

command -v jq >/dev/null 2>&1 || { echo "❌ jq is required but not installed"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "❌ curl is required but not installed"; exit 1; }

# Temp files for status/body capture; cleaned up on exit.
TMPDIR_DEMO="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_DEMO"' EXIT
BODY="$TMPDIR_DEMO/body"

# expect_status <expected> <actual> <label>
expect_status() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "✅ $label"
  else
    echo "❌ $label (expected $expected got $actual)"
    exit 1
  fi
}

# get_eligibility <query> — GETs eligibility with the default KEY, writing the
# body to $BODY and echoing the status code. $1 is the query string (after ?).
get_eligibility() {
  local query="$1"
  curl -s -o "$BODY" -w '%{http_code}' \
    -H "X-Signal-App-Key: $KEY" \
    "$BASE/v1/sdk/eligibility?$query"
}

# post_json <path> <json> -> writes body to $BODY, echoes status code.
post_json() {
  local path="$1" json="$2"
  curl -s -o "$BODY" -w '%{http_code}' \
    -H "X-Signal-App-Key: $KEY" \
    -H 'Content-Type: application/json' \
    -X POST "$BASE$path" \
    -d "$json"
}

# ISO-8601 instant helper.
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

echo "Signal M1 demo loop — BASE=$BASE"
echo

# ── Scenario 1: health ───────────────────────────────────────────────────────
status="$(curl -s -o "$BODY" -w '%{http_code}' "$BASE/health")"
expect_status 200 "$status" "1. /health → 200"

# ── Scenario 2: auth ─────────────────────────────────────────────────────────
status="$(curl -s -o "$BODY" -w '%{http_code}' \
  "$BASE/v1/sdk/eligibility?screen_id=order_completion&user_id=u_auth&client_id=cl_A&rep_tenure_days=200")"
expect_status 401 "$status" "2a. eligibility with NO key → 401"

status="$(curl -s -o "$BODY" -w '%{http_code}' \
  -H "X-Signal-App-Key: nope" \
  "$BASE/v1/sdk/eligibility?screen_id=order_completion&user_id=u_auth&client_id=cl_A&rep_tenure_days=200")"
expect_status 401 "$status" "2b. eligibility with wrong key → 401"

# ── Scenario 3: grant ────────────────────────────────────────────────────────
status="$(get_eligibility "screen_id=order_completion&user_id=u_demo_1&client_id=cl_A&rep_tenure_days=200")"
expect_status 200 "$status" "3. grant u_demo_1/cl_A/order_completion → 200"
TRIGGER_1="$(jq -r '.trigger_id' "$BODY")"
RATING_TYPE_1="$(jq -r '.rating_type' "$BODY")"
if [[ "$RATING_TYPE_1" != "star" ]]; then
  echo "❌ 3. rating_type (expected star got $RATING_TYPE_1)"
  exit 1
fi
echo "✅ 3. rating_type == star"
if [[ -z "$TRIGGER_1" || "$TRIGGER_1" == "null" ]]; then
  echo "❌ 3. trigger_id missing from grant response"
  exit 1
fi

# ── Scenario 4: debounce / suppress (immediate repeat) ───────────────────────
status="$(get_eligibility "screen_id=order_completion&user_id=u_demo_1&client_id=cl_A&rep_tenure_days=200")"
expect_status 204 "$status" "4. immediate repeat for u_demo_1 → 204 (suppressed)"

# ── Scenario 5: respond ──────────────────────────────────────────────────────
SHOWN="$(now_iso)"; RESP="$(now_iso)"
resp_body_1="$(jq -nc \
  --arg tid "$TRIGGER_1" --arg os "android" --arg ver "1.2.3" \
  --arg shown "$SHOWN" --arg responded "$RESP" \
  '{trigger_id:$tid, rating_value:5, device_os:$os, app_version:$ver, shown_at:$shown, responded_at:$responded}')"
status="$(post_json "/v1/sdk/response" "$resp_body_1")"
expect_status 204 "$status" "5. respond rating_value=5 on captured trigger → 204"

# ── Scenario 6: idempotent replay ────────────────────────────────────────────
status="$(post_json "/v1/sdk/response" "$resp_body_1")"
expect_status 204 "$status" "6. idempotent replay of same response → 204"

# ── Scenario 7: never re-ask ─────────────────────────────────────────────────
status="$(get_eligibility "screen_id=order_completion&user_id=u_demo_1&client_id=cl_A&rep_tenure_days=200")"
expect_status 204 "$status" "7. eligibility u_demo_1 after submit → 204 (never re-ask)"

# ── Scenario 8: dismiss path ─────────────────────────────────────────────────
status="$(get_eligibility "screen_id=order_completion&user_id=u_demo_2&client_id=cl_A&rep_tenure_days=200")"
expect_status 200 "$status" "8a. grant u_demo_2/cl_A/order_completion → 200"
TRIGGER_2="$(jq -r '.trigger_id' "$BODY")"
SHOWN2="$(now_iso)"; DIS2="$(now_iso)"
dismiss_body_2="$(jq -nc \
  --arg tid "$TRIGGER_2" --arg shown "$SHOWN2" --arg dismissed "$DIS2" \
  '{trigger_id:$tid, shown_at:$shown, dismissed_at:$dismissed}')"
status="$(post_json "/v1/sdk/dismiss" "$dismiss_body_2")"
expect_status 204 "$status" "8b. dismiss u_demo_2 trigger → 204"
status="$(get_eligibility "screen_id=order_completion&user_id=u_demo_2&client_id=cl_A&rep_tenure_days=200")"
expect_status 204 "$status" "8c. eligibility u_demo_2 after dismiss → 204 (weekly cooldown)"

# ── Scenario 9: validation (emoji bounds 1..3) ───────────────────────────────
status="$(get_eligibility "screen_id=new_customer_creation&user_id=u_demo_3&client_id=cl_A&rep_tenure_days=200")"
expect_status 200 "$status" "9a. grant u_demo_3/cl_A/new_customer_creation (emoji) → 200"
TRIGGER_3="$(jq -r '.trigger_id' "$BODY")"
RATING_TYPE_3="$(jq -r '.rating_type' "$BODY")"
if [[ "$RATING_TYPE_3" != "emoji" ]]; then
  echo "❌ 9a. rating_type (expected emoji got $RATING_TYPE_3)"
  exit 1
fi
SHOWN3="$(now_iso)"; RESP3="$(now_iso)"
# rating_value=4 is outside emoji bounds (1..3) → invalid_rating 422, records nothing.
resp_body_3_bad="$(jq -nc \
  --arg tid "$TRIGGER_3" --arg os "ios" --arg ver "2.0.0" \
  --arg shown "$SHOWN3" --arg responded "$RESP3" \
  '{trigger_id:$tid, rating_value:4, device_os:$os, app_version:$ver, shown_at:$shown, responded_at:$responded}')"
status="$(post_json "/v1/sdk/response" "$resp_body_3_bad")"
expect_status 422 "$status" "9b. respond rating_value=4 (emoji) → 422 invalid_rating"
# Same trigger is still un-answered (M1-D13 rejects before writing); rating=3 valid.
resp_body_3_ok="$(jq -nc \
  --arg tid "$TRIGGER_3" --arg os "ios" --arg ver "2.0.0" \
  --arg shown "$SHOWN3" --arg responded "$RESP3" \
  '{trigger_id:$tid, rating_value:3, device_os:$os, app_version:$ver, shown_at:$shown, responded_at:$responded}')"
status="$(post_json "/v1/sdk/response" "$resp_body_3_ok")"
expect_status 204 "$status" "9c. respond rating_value=3 on same trigger → 204"

# ── Scenario 10: tenure gate ─────────────────────────────────────────────────
status="$(get_eligibility "screen_id=new_customer_creation&user_id=u_demo_4&client_id=cl_B&rep_tenure_days=30")"
expect_status 204 "$status" "10a. u_demo_4/cl_B tenure 30 → 204 (under 90)"
status="$(get_eligibility "screen_id=new_customer_creation&user_id=u_demo_4&client_id=cl_B&rep_tenure_days=120")"
expect_status 200 "$status" "10b. u_demo_4/cl_B tenure 120 → 200 (no suppression from 204)"
# No rep_tenure_days param → fail-closed (M1-D8).
status="$(get_eligibility "screen_id=new_customer_creation&user_id=u_demo_5&client_id=cl_B")"
expect_status 204 "$status" "10c. u_demo_5/cl_B no tenure param → 204 (fail-closed)"

# ── Scenario 11: daily cap (no_cooldown, cap 2, 2s debounce) ─────────────────
status="$(get_eligibility "screen_id=goal_monitoring_page&user_id=u_demo_6&client_id=cl_A")"
expect_status 200 "$status" "11a. u_demo_6/cl_A goal_monitoring_page → 200 (1st)"
sleep 3
status="$(get_eligibility "screen_id=goal_monitoring_page&user_id=u_demo_6&client_id=cl_A")"
expect_status 200 "$status" "11b. u_demo_6/cl_A goal_monitoring_page → 200 (2nd)"
sleep 3
status="$(get_eligibility "screen_id=goal_monitoring_page&user_id=u_demo_6&client_id=cl_A")"
expect_status 204 "$status" "11c. u_demo_6/cl_A goal_monitoring_page → 204 (daily_cap 2 reached)"

# ── Scenario 12: race (two parallel eligibility calls) ───────────────────────
race_q="screen_id=order_completion&user_id=u_demo_7&client_id=cl_A&rep_tenure_days=200"
s_a="$TMPDIR_DEMO/race_a_status"; b_a="$TMPDIR_DEMO/race_a_body"
s_b="$TMPDIR_DEMO/race_b_status"; b_b="$TMPDIR_DEMO/race_b_body"
curl -s -o "$b_a" -w '%{http_code}' -H "X-Signal-App-Key: $KEY" \
  "$BASE/v1/sdk/eligibility?$race_q" > "$s_a" &
pid_a=$!
curl -s -o "$b_b" -w '%{http_code}' -H "X-Signal-App-Key: $KEY" \
  "$BASE/v1/sdk/eligibility?$race_q" > "$s_b" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"
status_a="$(cat "$s_a")"
status_b="$(cat "$s_b")"
# Exactly one 200 and one 204 (winner shows, loser suppressed).
ok=0
if { [[ "$status_a" == "200" && "$status_b" == "204" ]] || \
     [[ "$status_a" == "204" && "$status_b" == "200" ]]; }; then
  ok=1
fi
if [[ "$ok" == "1" ]]; then
  echo "✅ 12. race u_demo_7 → exactly one 200 and one 204 (got $status_a / $status_b)"
else
  echo "❌ 12. race u_demo_7 (expected one 200 + one 204 got $status_a / $status_b)"
  exit 1
fi

echo
echo "ALL SCENARIOS PASSED"
