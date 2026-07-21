#!/usr/bin/env bash
# Smoke test / conformance walkthrough for a DoneWise provider.
# Plays one day in the life of the board: the app adds tasks, the "agent"
# organises them, the app ticks one off, the agent archives it.
#
# Usage:
#   BASE=http://localhost:8080 APP_TOKEN=app AGENT_TOKEN=agent ./smoke.sh
#
# Against the reference adapter, run it first with e.g.:
#   DONEWISE_APP_TOKEN=app DONEWISE_AGENT_TOKEN=agent \
#   DONEWISE_DATA_DIR=/tmp/donewise-smoke DONEWISE_LISTEN_ADDR=:8080 \
#   go run .
set -euo pipefail

BASE="${BASE:-http://localhost:8080}"
APP_TOKEN="${APP_TOKEN:?set APP_TOKEN}"
AGENT_TOKEN="${AGENT_TOKEN:-$APP_TOKEN}"

pass=0
fail=0

check() { # check <label> <actual> <expected>
    if [ "$2" = "$3" ]; then
        echo "  ok: $1"
        pass=$((pass + 1))
    else
        echo "FAIL: $1 — expected '$3', got '$2'"
        fail=$((fail + 1))
    fi
}

app()   { curl -s -H "Authorization: Bearer $APP_TOKEN"   "$@"; }
agent() { curl -s -H "Authorization: Bearer $AGENT_TOKEN" "$@"; }
status_app() { curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $APP_TOKEN" "$@"; }

echo "1. health + auth"
check "healthz is open" "$(curl -s "$BASE/healthz" | grep -o '"status":"ok"')" '"status":"ok"'
check "board needs auth" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/board")" "401"
check "app token cannot PUT" "$(status_app -X PUT "$BASE/v1/board" \
    -d '{"base_revision":0,"groups":[],"inbox":[]}')" "403"

echo "2. app adds two tasks"
T1="smoke-$(date +%s)-1"
T2="smoke-$(date +%s)-2"
app -X POST "$BASE/v1/tasks" -d "{\"id\":\"$T1\",\"title\":\"reply to client\"}" >/dev/null
app -X POST "$BASE/v1/tasks" -d "{\"id\":\"$T2\",\"title\":\"buy printer paper\"}" >/dev/null
check "replay create is idempotent" \
    "$(app -X POST "$BASE/v1/tasks" -d "{\"id\":\"$T1\",\"title\":\"reply to client\"}" | grep -o "\"id\":\"$T1\"")" \
    "\"id\":\"$T1\""

echo "3. ETag polling"
ETAG=$(app -D - -o /dev/null "$BASE/v1/board" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag" {print $2}')
check "304 on unchanged board" \
    "$(status_app "$BASE/v1/board" -H "If-None-Match: $ETAG")" "304"

echo "4. agent organises the board"
REV=$(app "$BASE/v1/board" | grep -o '"revision":[0-9]*' | head -1 | cut -d: -f2)
agent -X PUT "$BASE/v1/board" -d "{
  \"base_revision\": $REV,
  \"groups\": [
    {\"id\": \"client-work\", \"name\": \"Client work\", \"priority\": \"high\",
     \"tasks\": [{\"id\": \"$T1\", \"title\": \"Reply to client about proposal\"}]},
    {\"id\": \"errands\", \"name\": \"Errands\", \"priority\": \"low\",
     \"tasks\": [{\"id\": \"$T2\", \"title\": \"buy printer paper\"}]}
  ],
  \"inbox\": []
}" >/dev/null
BOARD=$(app "$BASE/v1/board")
check "groups created" "$(echo "$BOARD" | grep -o '"id":"client-work"')" '"id":"client-work"'
check "task regrouped + retitled" \
    "$(echo "$BOARD" | grep -o '"title":"Reply to client about proposal"')" \
    '"title":"Reply to client about proposal"'
check "stale ETag now misses" \
    "$(status_app "$BASE/v1/board" -H "If-None-Match: $ETAG")" "200"

echo "5. app ticks a task; agent cannot untick it"
app -X PATCH "$BASE/v1/tasks/$T1" -d '{"done":true}' >/dev/null
REV=$(app "$BASE/v1/board" | grep -o '"revision":[0-9]*' | head -1 | cut -d: -f2)
agent -X PUT "$BASE/v1/board" -d "{
  \"base_revision\": $REV,
  \"groups\": [
    {\"id\": \"client-work\", \"name\": \"Client work\", \"priority\": \"high\",
     \"tasks\": [{\"id\": \"$T1\", \"title\": \"Reply to client about proposal\", \"done\": false}]},
    {\"id\": \"errands\", \"name\": \"Errands\", \"priority\": \"low\",
     \"tasks\": [{\"id\": \"$T2\", \"title\": \"buy printer paper\"}]}
  ],
  \"inbox\": []
}" >/dev/null
check "stored done-state wins over PUT" \
    "$(app "$BASE/v1/board" | grep -o "\"id\":\"$T1\",\"title\":[^,]*,\"done\":true")" \
    "\"id\":\"$T1\",\"title\":\"Reply to client about proposal\",\"done\":true"

echo "6. agent archives the done task by omission"
REV=$(app "$BASE/v1/board" | grep -o '"revision":[0-9]*' | head -1 | cut -d: -f2)
agent -X PUT "$BASE/v1/board" -d "{
  \"base_revision\": $REV,
  \"groups\": [
    {\"id\": \"errands\", \"name\": \"Errands\", \"priority\": \"low\",
     \"tasks\": [{\"id\": \"$T2\", \"title\": \"buy printer paper\"}]}
  ],
  \"inbox\": []
}" >/dev/null
check "archived task is gone" "$(app "$BASE/v1/board" | grep -c "$T1")" "0"
check "PATCH on archived task is 404" \
    "$(status_app -X PATCH "$BASE/v1/tasks/$T1" -d '{"done":false}')" "404"
check "DELETE is 404-tolerant" \
    "$(status_app -X DELETE "$BASE/v1/tasks/$T1")" "404"

echo "7. cleanup"
app -X DELETE "$BASE/v1/tasks/$T2" >/dev/null

echo
echo "$pass passed, $fail failed"
exit "$((fail > 0))"
