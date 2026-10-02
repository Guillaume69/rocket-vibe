#!/usr/bin/env bash
# Dedicated disposable Compose pilot; three real GTK processes and Secret Service.
set -euo pipefail
mkdir -p "$HOME" ../../artifacts
export XDG_RUNTIME_DIR="$HOME/runtime"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
Xvfb :99 -screen 0 1280x900x24 >/dev/null 2>&1 &
display_pid=$!
trap 'kill "$display_pid" 2>/dev/null || true' EXIT
sleep 1
export GDK_BACKEND=x11 DISPLAY=:99 GSK_RENDERER=cairo GTK_A11Y=none
export RV_SMOKE_NATIVE=1 RV_SMOKE_DELAY_MS=35000 RV_SMOKE_SIZE=435x760
run_with_keyring() {
  local log
  log=$(mktemp)
  if ! dbus-run-session -- bash -ec '
    printf "\n" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
    target/debug/rocket-vibe-gtk
  ' > "$log" 2>&1; then
    cat "$log"
    rm -f "$log"
    return 1
  fi
  cat "$log"
  if grep -Eq 'Keychain (write failed|write timed out|did not answer)' "$log"; then
    rm -f "$log"
    return 1
  fi
  rm -f "$log"
}
export RV_SMOKE_LOGIN='http://factor-proxy:3401|gtk-security|native-pilot-test-password'
export RV_SMOKE_FACTOR_FILE="$RV_NATIVE_SECURITY_FACTOR_FILE"
export RV_SMOKE_SECURITY=proof-regenerate
export RV_SMOKE_SHOT=/workspace/artifacts/native-desktop-security-proof.png
run_with_keyring
unset RV_SMOKE_LOGIN RV_SMOKE_FACTOR_FILE
export RV_SMOKE_SECURITY=restart-ack-disable
export RV_SMOKE_SHOT=/workspace/artifacts/native-desktop-security-resumed.png
run_with_keyring
export RV_SMOKE_SECURITY=removal-restart-ack-disable
export RV_SMOKE_SHOT=/workspace/artifacts/native-desktop-security-email-removed.png
run_with_keyring
echo 'GTK security: proof / mail verification / removal / factor ACK recovery and private receipts after process restart passed'
