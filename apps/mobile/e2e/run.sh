#!/usr/bin/env bash
# Maestro E2E suite (8.8): login, send, reconnect, upload, 2FA.
#
#   MAESTRO=/path/to/maestro e2e/run.sh
#
# Maestro is installed from the official GitHub release (NOT the
# curl | bash): https://github.com/mobile-dev-inc/maestro/releases
# -> maestro.zip, unzip, point MAESTRO to bin/maestro.
#
# Prerequisites: AVD started, app installed (dev build + Metro), local
# Rocket.Chat (docker compose up), `adb reverse` set by scripts/env.sh.
# Each flow is independent; the harness orchestrates the state between two
# (link cut, bob's 2FA, pushed file). In bash: the work loop forbids relying
# on zsh here (globs, word splitting).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
MAESTRO="${MAESTRO:-maestro}"
SERVER="${SERVER:-http://localhost:3000}"
# ALWAYS the emulator: a personal phone plugged in must never receive the
# suite by accident.
export ANDROID_SERIAL="${ANDROID_SERIAL:-emulator-5554}"
MAESTRO_ARGS=(--device "$ANDROID_SERIAL")
STAMP="$(date +%s)"
SECRET_FILE="/tmp/rocket-vibe-e2e-2fa-secret"

# The dev-client sometimes crashes natively (Fabric SIGSEGV,
# `MountingCoordinator::pullTransaction`, measured ~2 startups out of 8) on
# the first bundle load after `clearState`; never in release (0/8), never
# once the app is running. Appeared with reanimated 4.5 (8.9); until an
# upstream fix, flows starting from a BLANK state get a second try. Not the
# others: replaying 02/04 would post the same message again.
maestro_retry_cold() {
  if ! "$MAESTRO" "${MAESTRO_ARGS[@]}" test "$@"; then
    echo "   (second try: known dev-client crash on cold start)"
    "$MAESTRO" "${MAESTRO_ARGS[@]}" test "$@"
  fi
}

# An interrupted previous run may have left bob's 2FA active; flows 03 and
# 05 depend on it: we clean up UP FRONT with the persisted secret.
if [ -s "$SECRET_FILE" ]; then
  node "$HERE/harness/two-factor.mjs" disable "$(cat "$SECRET_FILE")" || true
  rm -f "$SECRET_FILE"
fi

echo "== 01 login (alice)"
maestro_retry_cold "$HERE/flows/01-login.yaml" \
  -e SERVER="$SERVER" -e USERNAME=alice -e PASSWORD=alice-dev-2026

echo "== 02 send"
"$MAESTRO" "${MAESTRO_ARGS[@]}" test "$HERE/flows/02-send.yaml" -e MSG="e2e-send-$STAMP"
# The Maestro assert would be satisfied by the OPTIMISTIC render alone: the
# truth comes from the server.
node "$HERE/harness/check-server.mjs" "e2e-send-$STAMP"

echo "== 03 reconnect (link cut while bob posts)"
# Whatever happens between the cut and the end, the link is RESTORED:
# without this trap, a failure midway would leave the emulator offline.
restore_link() { adb reverse tcp:3000 tcp:3000 >/dev/null 2>&1 || true; }
trap restore_link EXIT
adb reverse --remove tcp:3000 || true
node "$HERE/harness/post-as-bob.mjs" "e2e-reconnect-$STAMP"
sleep 8
restore_link
trap - EXIT
"$MAESTRO" "${MAESTRO_ARGS[@]}" test "$HERE/flows/03-reconnect.yaml" -e MSG="e2e-reconnect-$STAMP"

echo "== 04 upload (system picker)"
FILE="e2e-image-$STAMP.png"
# A valid 1x1 PNG, generated locally: nothing to version.
printf '\x89PNG\r\n\x1a\n' > "/tmp/$FILE"
python3 - "$FILE" <<'PY'
import struct, sys, zlib
name = sys.argv[1]
def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
data = zlib.compress(b'\x00\xff\x00\x00')
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) \
    + chunk(b'IDAT', data) + chunk(b'IEND', b'')
open(f'/tmp/{name}', 'wb').write(png)
PY
adb push "/tmp/$FILE" "/sdcard/Download/$FILE" >/dev/null
adb shell cmd media scan "/sdcard/Download/$FILE" >/dev/null 2>&1 || true
"$MAESTRO" "${MAESTRO_ARGS[@]}" test "$HERE/flows/04-upload.yaml" \
  -e CAPTION="e2e-upload-$STAMP" -e FILE="$FILE"
# The Maestro assert can match the caption still in the COMPOSER: the
# truth (message + attached file) comes from the server.
node "$HERE/harness/check-server.mjs" "e2e-upload-$STAMP" --file

echo "== 05 two factors (TOTP on bob)"
SECRET="$(node "$HERE/harness/two-factor.mjs" enable)"
printf '%s' "$SECRET" > "$SECRET_FILE"
clean_2fa() { node "$HERE/harness/two-factor.mjs" disable "$SECRET" || true; }
trap clean_2fa EXIT
# The retry recomputes its TOTP: the first try's would be stale (and
# Rocket.Chat refuses REUSE of an already consumed code).
if ! "$MAESTRO" "${MAESTRO_ARGS[@]}" test "$HERE/flows/05-two-factor.yaml" \
  -e SERVER="$SERVER" -e PASSWORD=bob-dev-2026 \
  -e TOTP="$(node "$HERE/harness/totp.mjs" "$SECRET" +30)"; then
  echo "   (second try: known dev-client crash on cold start)"
  "$MAESTRO" "${MAESTRO_ARGS[@]}" test "$HERE/flows/05-two-factor.yaml" \
    -e SERVER="$SERVER" -e PASSWORD=bob-dev-2026 \
    -e TOTP="$(node "$HERE/harness/totp.mjs" "$SECRET" +30)"
fi
trap - EXIT
# The FINAL cleanup is not optional: a failed disable with a lost secret
# blocks every following run (the trap's || true only covers the suite's
# FAILURE path, where the original error takes precedence).
node "$HERE/harness/two-factor.mjs" disable "$SECRET"
rm -f "$SECRET_FILE"

echo "== restore: alice session"
maestro_retry_cold "$HERE/flows/01-login.yaml" \
  -e SERVER="$SERVER" -e USERNAME=alice -e PASSWORD=alice-dev-2026

echo "E2E SUITE GREEN ($ROOT)"
