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

ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RACINE="$(dirname "$ICI")"
MAESTRO="${MAESTRO:-maestro}"
SERVEUR="${SERVEUR:-http://localhost:3000}"
# ALWAYS the emulator: a personal phone plugged in must never receive the
# suite by accident.
export ANDROID_SERIAL="${ANDROID_SERIAL:-emulator-5554}"
MAESTRO_ARGS=(--device "$ANDROID_SERIAL")
HORODATAGE="$(date +%s)"
FICHIER_SECRET="/tmp/rocket-vibe-e2e-2fa-secret"

# The dev-client sometimes crashes natively (Fabric SIGSEGV,
# `MountingCoordinator::pullTransaction`, measured ~2 startups out of 8) on
# the first bundle load after `clearState`; never in release (0/8), never
# once the app is running. Appeared with reanimated 4.5 (8.9); until an
# upstream fix, flows starting from a BLANK state get a second try. Not the
# others: replaying 02/04 would post the same message again.
maestro_retry_froid() {
  if ! "$MAESTRO" "${MAESTRO_ARGS[@]}" test "$@"; then
    echo "   (second try: known dev-client crash on cold start)"
    "$MAESTRO" "${MAESTRO_ARGS[@]}" test "$@"
  fi
}

# An interrupted previous run may have left bob's 2FA active; flows 03 and
# 05 depend on it: we clean up UP FRONT with the persisted secret.
if [ -s "$FICHIER_SECRET" ]; then
  node "$ICI/harness/two-factor.mjs" disable "$(cat "$FICHIER_SECRET")" || true
  rm -f "$FICHIER_SECRET"
fi

echo "== 01 login (alice)"
maestro_retry_froid "$ICI/flows/01-login.yaml" \
  -e SERVEUR="$SERVEUR" -e UTILISATEUR=alice -e MOT_DE_PASSE=alice-dev-2026

echo "== 02 send"
"$MAESTRO" "${MAESTRO_ARGS[@]}" test "$ICI/flows/02-send.yaml" -e MSG="e2e-envoi-$HORODATAGE"
# The Maestro assert would be satisfied by the OPTIMISTIC render alone: the
# truth comes from the server.
node "$ICI/harness/check-server.mjs" "e2e-envoi-$HORODATAGE"

echo "== 03 reconnect (link cut while bob posts)"
# Whatever happens between the cut and the end, the link is RESTORED:
# without this trap, a failure midway would leave the emulator offline.
retablir_lien() { adb reverse tcp:3000 tcp:3000 >/dev/null 2>&1 || true; }
trap retablir_lien EXIT
adb reverse --remove tcp:3000 || true
node "$ICI/harness/post-as-bob.mjs" "e2e-reconnexion-$HORODATAGE"
sleep 8
retablir_lien
trap - EXIT
"$MAESTRO" "${MAESTRO_ARGS[@]}" test "$ICI/flows/03-reconnect.yaml" -e MSG="e2e-reconnexion-$HORODATAGE"

echo "== 04 upload (system picker)"
FICHIER="e2e-image-$HORODATAGE.png"
# A valid 1x1 PNG, generated locally: nothing to version.
printf '\x89PNG\r\n\x1a\n' > "/tmp/$FICHIER"
python3 - "$FICHIER" <<'PY'
import struct, sys, zlib
nom = sys.argv[1]
def bloc(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
donnees = zlib.compress(b'\x00\xff\x00\x00')
png = b'\x89PNG\r\n\x1a\n' + bloc(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) \
    + bloc(b'IDAT', donnees) + bloc(b'IEND', b'')
open(f'/tmp/{nom}', 'wb').write(png)
PY
adb push "/tmp/$FICHIER" "/sdcard/Download/$FICHIER" >/dev/null
adb shell cmd media scan "/sdcard/Download/$FICHIER" >/dev/null 2>&1 || true
"$MAESTRO" "${MAESTRO_ARGS[@]}" test "$ICI/flows/04-upload.yaml" \
  -e LEGENDE="e2e-upload-$HORODATAGE" -e FICHIER="$FICHIER"
# The Maestro assert can match the caption still in the COMPOSER: the
# truth (message + attached file) comes from the server.
node "$ICI/harness/check-server.mjs" "e2e-upload-$HORODATAGE" --file

echo "== 05 two factors (TOTP on bob)"
SECRET="$(node "$ICI/harness/two-factor.mjs" enable)"
printf '%s' "$SECRET" > "$FICHIER_SECRET"
nettoyer_2fa() { node "$ICI/harness/two-factor.mjs" disable "$SECRET" || true; }
trap nettoyer_2fa EXIT
# The retry recomputes its TOTP: the first try's would be stale (and
# Rocket.Chat refuses REUSE of an already consumed code).
if ! "$MAESTRO" "${MAESTRO_ARGS[@]}" test "$ICI/flows/05-two-factor.yaml" \
  -e SERVEUR="$SERVEUR" -e MOT_DE_PASSE=bob-dev-2026 \
  -e TOTP="$(node "$ICI/harness/totp.mjs" "$SECRET" +30)"; then
  echo "   (second try: known dev-client crash on cold start)"
  "$MAESTRO" "${MAESTRO_ARGS[@]}" test "$ICI/flows/05-two-factor.yaml" \
    -e SERVEUR="$SERVEUR" -e MOT_DE_PASSE=bob-dev-2026 \
    -e TOTP="$(node "$ICI/harness/totp.mjs" "$SECRET" +30)"
fi
trap - EXIT
# The FINAL cleanup is not optional: a failed disable with a lost secret
# blocks every following run (the trap's || true only covers the suite's
# FAILURE path, where the original error takes precedence).
node "$ICI/harness/two-factor.mjs" disable "$SECRET"
rm -f "$FICHIER_SECRET"

echo "== restore: alice session"
maestro_retry_froid "$ICI/flows/01-login.yaml" \
  -e SERVEUR="$SERVEUR" -e UTILISATEUR=alice -e MOT_DE_PASSE=alice-dev-2026

echo "E2E SUITE GREEN ($RACINE)"
