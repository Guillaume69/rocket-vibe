#!/usr/bin/env bash
# Message actions end to end, against the seeded bench: the app (as alice)
# reacts to bob's latest message, quotes it, edits her own latest message and
# replies in a thread. Each effect is then checked on the server over REST.
#   scripts/e2e-actions.sh [server]        (default http://localhost:3000)
set -euo pipefail
cd "$(dirname "$0")/.."
server=${1:-http://localhost:3000}
tag="act-$(date +%s)-$RANDOM"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

api() { curl -fsS "$@"; }
login() { api -H 'Content-Type: application/json' -d "{\"user\":\"$1\",\"password\":\"$2\"}" "$server/api/v1/login"; }
auth_of() { python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(d['authToken'], d['userId'])" <<<"$1"; }
read -r bob_token bob_id < <(auth_of "$(login bob bob-dev-2026)")
read -r alice_token alice_id < <(auth_of "$(login alice alice-dev-2026)")
post() {
  api -H "X-Auth-Token: $1" -H "X-User-Id: $2" -H 'Content-Type: application/json' \
    -d "{\"channel\":\"#test-public\",\"text\":\"$3\"}" "$server/api/v1/chat.postMessage" |
    python3 -c "import json,sys; print(json.load(sys.stdin)['message']['_id'])"
}
target=$(post "$bob_token" "$bob_id" "$tag target")
mine=$(post "$alice_token" "$alice_id" "$tag mine")

status=0
RV_SMOKE_ACTIONS="$tag" RV_SMOKE_DELAY_MS=16000 \
  scripts/smoke.sh "$server" alice alice-dev-2026 test-public "$out/actions.png" | grep '^smoke: \(actions\|thread\)' || status=$?
cp "$out/actions.png" "${SHOT:-/dev/null}" 2>/dev/null || true

rid=$(api -H "X-Auth-Token: $bob_token" -H "X-User-Id: $bob_id" "$server/api/v1/channels.info?roomName=test-public" |
  python3 -c "import json,sys; print(json.load(sys.stdin)['channel']['_id'])")
api -H "X-Auth-Token: $bob_token" -H "X-User-Id: $bob_id" "$server/api/v1/channels.history?roomId=$rid&count=100&showThreadMessages=true" > "$out/history.json"
api -H "X-Auth-Token: $bob_token" -H "X-User-Id: $bob_id" "$server/api/v1/chat.getMessage?msgId=$mine" > "$out/mine.json"
python3 - "$out" "$tag" "$target" "$mine" <<'PY' || status=1
import json, sys
out, tag, target, mine = sys.argv[1:]
messages = json.load(open(f"{out}/history.json"))["messages"]
by_id = {m["_id"]: m for m in messages}
checks = {
    "reaction on bob's message": "alice" in by_id.get(target, {}).get("reactions", {}).get(":+1:", {}).get("usernames", []),
    "quote carries bob's permalink": any(
        m.get("u", {}).get("username") == "alice" and m.get("msg", "").startswith("[ ](") and f"msg={target}" in m["msg"]
        and m["msg"].endswith(f"{tag} reply") for m in messages),
    "own message edited": json.load(open(f"{out}/mine.json"))["message"]["msg"] == f"{tag} edited",
    "reply lands in the thread": any(m.get("msg") == f"{tag} in thread" and m.get("tmid") for m in messages),
}
for name, ok in checks.items():
    print(f"server: {name}: {'ok' if ok else 'FAILED'}")
sys.exit(0 if all(checks.values()) else 1)
PY
[ "$status" = 0 ] && echo "e2e-actions: PASS" || echo "e2e-actions: FAIL"
exit "$status"
