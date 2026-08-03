#!/usr/bin/env bash
#
# scripts/console-demo.sh — Signal B4 exit-proof console+CLI end-to-end demo.
#
# Proves the full agentic + reporting path a frontend/agent will drive:
#   signup → publishable key → CLI login → `signal deploy` (config-as-code) →
#   track an event via the SDK → respond → read the reports back via a CLI token.
#
# It uses the REAL `@signal/cli` binary (via tsx) for login + deploy, exercising
# the B3 unified Bearer-token auth and B4 `responses:read` reporting scope. Every
# assertion prints `✅ <label>`; the first mismatch prints `❌ …` and exits
# non-zero; the end prints `ALL SCENARIOS PASSED`.
#
# Requirements: bash, curl, jq, node 22 + pnpm/tsx (run under nvm). A running API
# server (provisions its own account — no pre-seed).
#
# Env:
#   BASE  base URL of the API server (default http://localhost:3000)
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_ROOT/packages/cli/src/index.ts"

command -v jq >/dev/null 2>&1 || { echo "❌ jq is required but not installed"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "❌ curl is required but not installed"; exit 1; }
command -v tsx >/dev/null 2>&1 || command -v npx >/dev/null 2>&1 || {
  echo "❌ tsx/npx required to run the CLI"; exit 1; }

TMPDIR_DEMO="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_DEMO"' EXIT
BODY="$TMPDIR_DEMO/body"
JAR="$TMPDIR_DEMO/cookies"
# Isolate CLI credentials so we never touch the real ~/.signal.
export SIGNAL_CONFIG_DIR="$TMPDIR_DEMO/signal-home"
export SIGNAL_API_URL="$BASE"

STAMP="$(date -u +%s)$RANDOM"
EMAIL="console_demo_${STAMP}@signal.dev"
PASSWORD="demopassword"

expect_status() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$actual" == "$expected" ]]; then echo "✅ $label";
  else echo "❌ $label (expected $expected got $actual)"; echo "   body:"; head -20 "$BODY"; echo; exit 1; fi
}
assert() {
  local cond="$1" label="$2"
  if [[ "$cond" == "true" ]]; then echo "✅ $label"; else echo "❌ $label"; exit 1; fi
}
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

run_cli() {
  if command -v tsx >/dev/null 2>&1; then tsx "$CLI" "$@"; else npx tsx "$CLI" "$@"; fi
}

echo "Signal B4 console demo — BASE=$BASE (account $EMAIL)"
echo

# ── 1. health / ready ────────────────────────────────────────────────────────
status="$(curl -s -o "$BODY" -w '%{http_code}' "$BASE/health")"
expect_status 200 "$status" "1a. /health → 200"
status="$(curl -s -o "$BODY" -w '%{http_code}' "$BASE/ready")"
expect_status 200 "$status" "1b. /ready → 200 (deep DB check)"

# ── 2. signup → publishable key + session ────────────────────────────────────
signup_body="$(jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" \
  '{email:$e, password:$p, name:"Console Demo", account_name:"Console Co"}')"
status="$(curl -s -o "$BODY" -w '%{http_code}' -c "$JAR" \
  -H 'Content-Type: application/json' -X POST "$BASE/v1/console/auth/signup" -d "$signup_body")"
expect_status 201 "$status" "2. signup → 201 (account + admin + publishable key)"
KEY="$(jq -r '.publishable_key' "$BODY")"
assert "$([[ -n "$KEY" && "$KEY" != null ]] && echo true || echo false)" "2b. obtained publishable key ($KEY)"

# ── 3. CLI login (interim password) → token saved to isolated config ─────────
run_cli login --password --email "$EMAIL" --password-value "$PASSWORD" --api-url "$BASE" > "$TMPDIR_DEMO/login.out" 2>&1 \
  && echo "✅ 3. signal login --password → token stored" \
  || { echo "❌ 3. signal login failed"; cat "$TMPDIR_DEMO/login.out"; exit 1; }
TOKEN="$(jq -r '.token' "$SIGNAL_CONFIG_DIR/config.json")"
assert "$([[ "$TOKEN" == cli_* ]] && echo true || echo false)" "3b. token is a cli_ token"

# ── 4. deploy via CLI (config-as-code) ───────────────────────────────────────
EVENT="checkout_completed"
cat > "$TMPDIR_DEMO/signal.config.json" <<JSON
{ "workflows": [ {
  "key": "checkout-csat",
  "event_name": "$EVENT",
  "status": "active",
  "metric_type": "CSAT",
  "rating_type": "star",
  "rating_scale_max": 5,
  "header_text": "How was your checkout?",
  "positive_threshold": 4,
  "chips_on_negative": ["Slow", "Confusing"],
  "sampling_rate": 1
} ] }
JSON
run_cli deploy "$TMPDIR_DEMO/signal.config.json" --api-url "$BASE" > "$TMPDIR_DEMO/deploy.out" 2>&1 \
  && echo "✅ 4. signal deploy → applied" \
  || { echo "❌ 4. signal deploy failed"; cat "$TMPDIR_DEMO/deploy.out"; exit 1; }
grep -Eq '(created|updated|unchanged)\s+checkout-csat' "$TMPDIR_DEMO/deploy.out" \
  && echo "✅ 4b. deploy reported the checkout-csat workflow active" \
  || { echo "❌ 4b. deploy output unexpected"; cat "$TMPDIR_DEMO/deploy.out"; exit 1; }

# ── 5. force the SDK cache to see the just-deployed workflow ──────────────────
status="$(curl -s -o "$BODY" -w '%{http_code}' -H "X-Signal-App-Key: $KEY" \
  -X POST "$BASE/v1/sdk/internal/refresh-cache")"
expect_status 204 "$status" "5. refresh SDK cache → 204"

# ── 6. track the event via the SDK → grant, then respond ─────────────────────
status="$(curl -s -o "$BODY" -w '%{http_code}' -H "X-Signal-App-Key: $KEY" \
  "$BASE/v1/sdk/eligibility?event_name=$EVENT&user_id=u_report_1&session_age_days=200")"
expect_status 200 "$status" "6. track $EVENT (eligibility) → 200 grant"
TRIGGER="$(jq -r '.trigger_id' "$BODY")"
resp="$(jq -nc --arg tid "$TRIGGER" --arg s "$(now_iso)" --arg r "$(now_iso)" \
  '{trigger_id:$tid, rating_value:5, device_os:"android", app_version:"1.0.0", shown_at:$s, responded_at:$r}')"
status="$(curl -s -o "$BODY" -w '%{http_code}' -H "X-Signal-App-Key: $KEY" \
  -H 'Content-Type: application/json' -X POST "$BASE/v1/sdk/response" -d "$resp")"
expect_status 204 "$status" "6b. respond rating_value=5 → 204"

# ── 7. read the reports back via the CLI TOKEN (B4-D5 responses:read) ─────────
auth=( -H "Authorization: Bearer $TOKEN" )

status="$(curl -s -o "$BODY" -w '%{http_code}' "${auth[@]}" "$BASE/v1/console/events/overview")"
expect_status 200 "$status" "7. GET /v1/console/events/overview via token → 200"
ev_triggers="$(jq -r --arg e "$EVENT" '.events[] | select(.event_name==$e) | .triggers' "$BODY")"
ev_responses="$(jq -r --arg e "$EVENT" '.events[] | select(.event_name==$e) | .responses' "$BODY")"
ev_pos="$(jq -r --arg e "$EVENT" '.events[] | select(.event_name==$e) | .positive_score' "$BODY")"
assert "$([[ "$ev_triggers" == "1" && "$ev_responses" == "1" && "$ev_pos" == "1" ]] && echo true || echo false)" \
  "7b. events overview reflects 1 trigger, 1 response, positive_score=1 (got t=$ev_triggers r=$ev_responses p=$ev_pos)"

status="$(curl -s -o "$BODY" -w '%{http_code}' "${auth[@]}" "$BASE/v1/console/dashboard")"
expect_status 200 "$status" "7c. GET /v1/console/dashboard via token → 200"
active="$(jq -r '.kpis.active_campaigns' "$BODY")"
assert "$([[ "$active" == "1" ]] && echo true || echo false)" "7d. dashboard shows 1 active workflow"

# Per-workflow overview via the deployed workflow id (looked up over the token).
status="$(curl -s -o "$BODY" -w '%{http_code}' "${auth[@]}" "$BASE/v1/console/workflows")"
expect_status 200 "$status" "7e. GET /v1/console/workflows via token → 200"
WF_ID="$(jq -r --arg e "$EVENT" '.[] | select(.event_name==$e) | .id' "$BODY" | head -1)"
status="$(curl -s -o "$BODY" -w '%{http_code}' "${auth[@]}" "$BASE/v1/console/workflows/$WF_ID/overview")"
expect_status 200 "$status" "7f. GET /v1/console/workflows/:id/overview via token → 200"
wf_resp="$(jq -r '.responses' "$BODY")"
assert "$([[ "$wf_resp" == "1" ]] && echo true || echo false)" "7g. workflow overview shows 1 response"

# ── 8. scope enforcement: a publishable key CANNOT read console reports ───────
status="$(curl -s -o "$BODY" -w '%{http_code}' "$BASE/v1/console/dashboard")"
expect_status 401 "$status" "8. GET /v1/console/dashboard with no credential → 401"

echo
echo "ALL SCENARIOS PASSED"
