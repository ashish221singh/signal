#!/usr/bin/env bash
#
# scripts/agent-setup-demo.sh — proof of the agent-guided setup loop end to end.
#
# Tells the product story: a dev logs in, an agent says "set up a CSAT for checkout"
# with partial info, the backend ASKS BACK with machine-readable questions, the agent
# completes + publishes, then the sheet asks each end-user politely — backing off for
# the ask_frequency window if ignored, and never re-asking anyone who responded.
#
# Faithful to the real surfaces: console calls use a cli_ Bearer token (exactly what
# @signal/mcp and `signal setup` send); SDK calls use the publishable key (@signal/web).
#
# Requires: bash, curl, jq, and a running API (BASE, default http://localhost:3000).
# Self-provisions its own account — no seed needed. Prints ALL SCENARIOS PASSED.
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
command -v jq >/dev/null || { echo "jq required"; exit 1; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT; BODY="$T/body"
STAMP="$(date -u +%s)$RANDOM"; EMAIL="agent_${STAMP}@signal.dev"
now(){ date -u +%Y-%m-%dT%H:%M:%SZ; }
say(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
ok(){ printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad(){ printf '  \033[31m✗ %s\033[0m\n' "$*"; head -c 400 "$BODY"; echo; exit 1; }
expect(){ [ "$2" = "$1" ] && ok "$3 → $2" || bad "$3 (expected $1 got $2)"; }

# console (agent / MCP / `signal setup`) — Bearer token
c_post(){ local b="${2:-}"; [ -z "$b" ] && b='{}'; curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$BASE$1" -d "$b"; }
c_patch(){ curl -s -o "$BODY" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X PATCH "$BASE$1" -d "$2"; }
# sdk (end-user) — publishable key
s_get(){ curl -s -o "$BODY" -w '%{http_code}' -H "X-Signal-App-Key: $KEY" "$BASE/v1/sdk/eligibility?$1"; }
s_post(){ curl -s -o "$BODY" -w '%{http_code}' -H "X-Signal-App-Key: $KEY" -H 'Content-Type: application/json' -X POST "$BASE$1" -d "$2"; }
refresh(){ curl -s -o "$BODY" -w '%{http_code}' -H "X-Signal-App-Key: $KEY" -X POST "$BASE/v1/sdk/internal/refresh-cache"; }

say "0. Provision (what 'signal login' + the SDK key give you)"
signup="$(jq -nc --arg e "$EMAIL" '{email:$e,password:"demopassword",name:"Dev",account_name:"Acme"}')"
expect 201 "$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' -X POST "$BASE/v1/console/auth/signup" -d "$signup")" "signup"
KEY="$(jq -r '.publishable_key' "$BODY")"; ok "publishable key: $KEY"
login="$(jq -nc --arg e "$EMAIL" '{email:$e,password:"demopassword"}')"
expect 200 "$(curl -s -o "$BODY" -w '%{http_code}' -H 'Content-Type: application/json' -X POST "$BASE/v1/cli/login" -d "$login")" "cli login (device-flow stand-in)"
TOKEN="$(jq -r '.token' "$BODY")"; ok "cli token: ${TOKEN:0:12}…"

say "1. Agent: 'set up a CSAT for checkout' — it only knows the event so far"
expect 201 "$(c_post /v1/console/workflows)" "create draft"
WF="$(jq -r '.id' "$BODY")"
expect 200 "$(c_patch "/v1/console/workflows/$WF" '{"event_name":"checkout_completed","metric_type":"CSAT"}')" "set what it knows (event + CSAT)"

say "2. Agent tries to publish → backend ASKS BACK with real questions"
expect 422 "$(c_post "/v1/console/workflows/$WF/publish")" "publish blocked"
[ "$(jq -r '.error.code' "$BODY")" = "incomplete" ] && ok "code=incomplete" || bad "expected incomplete"
[ "$(jq -r '.questions | length' "$BODY")" -gt 0 ] && ok "backend returned $(jq -r '.questions | length' "$BODY") human questions:" || bad "no questions returned"
jq -r '.questions[] | "        • " + .question + (if .options then "  [" + ([.options[].value] | join(" | ")) + "]" else "" end)' "$BODY"

say "3. Agent got the answers (stars, media on, thank happy / redirect unhappy) → completes + publishes"
answers='{"rating_type":"star","rating_scale_max":5,"header_text":"How was placing this order?","positive_threshold":4,"other_allows_image":true,"positive_action":{"type":"store_review"},"negative_action":{"type":"redirect","url":"https://support.acme.com/checkout"}}'
expect 200 "$(c_patch "/v1/console/workflows/$WF" "$answers")" "fill the answers"
expect 200 "$(c_post "/v1/console/workflows/$WF/publish")" "publish → active"
ok "actions: positive=$(jq -r '.positive_action.type' "$BODY"), negative=$(jq -r '.negative_action.type' "$BODY")"
expect 204 "$(refresh)" "refresh SDK cache"

say "4. End-user who IGNORES → asked again after the ask_frequency window"
expect 200 "$(s_get 'event_name=checkout_completed&user_id=u_ignore&session_age_days=200')" "u_ignore: sheet shown"
TID="$(jq -r '.trigger_id' "$BODY")"
expect 204 "$(s_post /v1/sdk/dismiss "$(jq -nc --arg t "$TID" --arg s "$(now)" --arg d "$(now)" '{trigger_id:$t,shown_at:$s,dismissed_at:$d}')")" "u_ignore: dismissed"
expect 204 "$(s_get 'event_name=checkout_completed&user_id=u_ignore&session_age_days=200')" "u_ignore: re-checked → 204 (in cooldown, back after 7d)"

say "5. End-user who RESPONDS → never asked again"
expect 200 "$(s_get 'event_name=checkout_completed&user_id=u_answer&session_age_days=200')" "u_answer: sheet shown"
TID="$(jq -r '.trigger_id' "$BODY")"
expect 204 "$(s_post /v1/sdk/response "$(jq -nc --arg t "$TID" --arg s "$(now)" --arg r "$(now)" '{trigger_id:$t,rating_value:5,device_os:"web",app_version:"1.0.0",shown_at:$s,responded_at:$r}')")" "u_answer: submitted 5★ (happy → store_review)"
expect 204 "$(s_get 'event_name=checkout_completed&user_id=u_answer&session_age_days=200')" "u_answer: re-checked → 204 (never re-ask)"

say "6. A brand-new user is still asked (per-user, not global)"
expect 200 "$(s_get 'event_name=checkout_completed&user_id=u_fresh&session_age_days=200')" "u_fresh: sheet shown"

printf '\n\033[1;32mALL SCENARIOS PASSED\033[0m\n'
