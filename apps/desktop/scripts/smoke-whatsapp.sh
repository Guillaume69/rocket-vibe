#!/usr/bin/env bash
# The WhatsApp account end to end in the GTK app, against the synthetic helper
# only (rv-core's fake-whatsapp-sidecar, which "scans" its own QR). Never run
# automatic captures against a real account. Screenshots land in .cache/whatsapp/.
#   scripts/smoke-whatsapp.sh            binaries in apps/desktop/target/debug (build.sh)
#   RV_CARGO_TARGET=/cargo/target-desktop scripts/smoke-whatsapp.sh
#                                        binaries in that directory of the rv-cargo volume
# On Windows Git Bash, set MSYS_NO_PATHCONV=1.
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$(cd ../.. && pwd)
out=$(mkdir -p ../../.cache/whatsapp && cd ../../.cache/whatsapp && pwd)
if command -v cygpath >/dev/null 2>&1; then repo=$(cygpath -m "$repo"); out=$(cygpath -m "$out"); fi
bin=./target/debug
volume=()
if [[ -n "${RV_CARGO_TARGET:-}" ]]; then bin="$RV_CARGO_TARGET/debug"; volume=(-v rv-cargo:/cargo); fi
rm -f "$out/link.png" "$out/chat.png"
log=$(mktemp)
docker run --rm --cap-add IPC_LOCK -v "$repo:/workspace" "${volume[@]}" -v "$out:/out" -w /workspace/apps/desktop \
  -e HOME=/tmp/whatsapp-smoke -e DISPLAY=:99 -e GDK_BACKEND=x11 -e GSK_RENDERER=cairo -e GTK_A11Y=none \
  -e RV_SMOKE_WHATSAPP=/out -e RV_WHATSAPP_HELPER="$bin/fake-whatsapp-sidecar" -e RV_FAKE_WHATSAPP_SCAN_MS=3000 \
  -e BIN="$bin" rocket-vibe-rs-build bash -ec '
    mkdir -p "$HOME/.config/rocket-vibe-rs"
    printf fr > "$HOME/.config/rocket-vibe-rs/language"
    Xvfb :99 -screen 0 1280x900x24 >/dev/null 2>&1 &
    exec dbus-run-session -- bash -ec "printf \"\n\" | gnome-keyring-daemon --unlock --components=secrets >/dev/null; exec \"$BIN/rocket-vibe-gtk\""
  ' >"$log" 2>&1 || true
grep '^smoke:' "$log" || cat "$log"
grep -q '^smoke: whatsapp text sent through the composer: () ok' "$log"
if grep -q '^smoke:.*FAILED' "$log"; then exit 1; fi
test -s "$out/link.png" && test -s "$out/chat.png"
rm -f "$log"
echo "whatsapp smoke: ok"
