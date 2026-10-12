#!/usr/bin/env bash
# Render only synthetic WhatsApp data. Never run automatic capture on a real account.
#   scripts/smoke-whatsapp.sh            binaries in apps/desktop/target/debug (build.sh)
#   RV_CARGO_TARGET=/cargo/target-desktop scripts/smoke-whatsapp.sh
#                                        binaries in that directory of the rv-cargo volume
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$(cd ../.. && pwd)
out=$(mkdir -p ../../.cache/whatsapp && cd ../../.cache/whatsapp && pwd)
if command -v cygpath >/dev/null 2>&1; then repo=$(cygpath -m "$repo"); out=$(cygpath -m "$out"); fi
bin=./target/debug
volume=()
if [[ -n "${RV_CARGO_TARGET:-}" ]]; then bin="$RV_CARGO_TARGET/debug"; volume=(-v rv-cargo:/cargo); fi
for mode in qr chat; do
  log=$(mktemp)
  docker run --rm -v "$repo:/workspace" "${volume[@]}" -v "$out:/out" -w /workspace/apps/desktop \
    -e HOME=/tmp/whatsapp-smoke -e DISPLAY=:99 -e GDK_BACKEND=x11 -e GSK_RENDERER=cairo -e GTK_A11Y=none \
    -e RV_WHATSAPP_PILOT=1 -e RV_WHATSAPP_SMOKE="$mode" -e RV_WHATSAPP_SMOKE_SHOT="/out/$mode.png" -e BIN="$bin" \
    rocket-vibe-rs-build dbus-run-session -- bash -ec '
      mkdir -p "$HOME/.config/rocket-vibe-rs"
      printf fr > "$HOME/.config/rocket-vibe-rs/language"
      Xvfb :99 -screen 0 1280x900x24 >/dev/null 2>&1 &
      exec "$BIN/rocket-vibe-gtk"
    ' >"$log" 2>&1 || true
  cat "$log"
  grep -q 'whatsapp smoke: native flow=true screenshot=true' "$log"
  test -s "$out/$mode.png"
  rm -f "$log"
done
