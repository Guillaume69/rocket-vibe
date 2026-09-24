#!/usr/bin/env bash
# End-to-end test against a live Rocket.Chat seeded by ../rocket-vibe/scripts/seed.mjs.
# The real app (headless, in the build image) logs in as alice and opens
# test-public; it sends a message while bob posts one, and posts then deletes
# another, over REST. It passes when the app shows alice's and bob's messages
# exactly once and not the deleted one, and the server holds alice's message
# exactly once.
#   scripts/e2e.sh [server]        (default http://localhost:3000)
set -euo pipefail
cd "$(dirname "$0")/.."
server=${1:-http://localhost:3000}
run="e2e-$(date +%s)-$RANDOM"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

api() { curl -fsS "$@"; }
field() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

bob=$(api -H 'Content-Type: application/json' -d '{"user":"bob","password":"bob-dev-2026"}' "$server/api/v1/login")
bob_auth=(-H "X-Auth-Token: $(field "d['data']['authToken']" <<<"$bob")" -H "X-User-Id: $(field "d['data']['userId']" <<<"$bob")")

(
  sleep 10
  post() { api "${bob_auth[@]}" -H 'Content-Type: application/json' -d "{\"channel\":\"#test-public\",\"text\":\"$1\"}" "$server/api/v1/chat.postMessage"; }
  post "$run from bob" >/dev/null
  doomed=$(post "$run deleted")
  sleep 2
  api "${bob_auth[@]}" -H 'Content-Type: application/json' \
    -d "{\"roomId\":\"$(field "d['message']['rid']" <<<"$doomed")\",\"msgId\":\"$(field "d['message']['_id']" <<<"$doomed")\"}" \
    "$server/api/v1/chat.delete" >/dev/null
) &
writer=$!

status=0
RV_SMOKE_DELAY_MS=20000 \
RV_SMOKE_EXPECT="$run from alice|$run from bob" \
RV_SMOKE_EXPECT_ABSENT="$run deleted" \
  scripts/smoke.sh "$server" alice alice-dev-2026 test-public "$out/e2e.png" "$run from alice" \
  | grep '^smoke:' || status=$?
wait "$writer"

rid=$(api "${bob_auth[@]}" "$server/api/v1/channels.info?roomName=test-public" | field "d['channel']['_id']")
history=$(api "${bob_auth[@]}" "$server/api/v1/channels.history?roomId=$rid&count=50")
copies=$(field "sum(1 for m in d['messages'] if m.get('msg') == '$run from alice')" <<<"$history")
echo "server: alice's message stored $copies time(s)"
[ "$copies" = 1 ] || status=1

[ "$status" = 0 ] && echo "e2e: PASS" || echo "e2e: FAIL"
exit "$status"
