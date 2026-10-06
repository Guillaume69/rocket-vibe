#!/usr/bin/env bash
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
export RV_SMOKE_SHOT=/workspace/artifacts/native-desktop-email-settings.png
for phase in enable resume-disable resume-disabled; do
  export RV_SMOKE_EMAIL_SETTINGS_PHASE="$phase"
  if [ "$phase" = enable ]; then
    export RV_SMOKE_LOGIN='http://factor-proxy:3401|gtk-email|native-pilot-test-password'
  else unset RV_SMOKE_LOGIN; fi
  dbus-run-session -- bash -ec '
    printf "\n" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
    target/debug/rocket-vibe-gtk
  '
done
echo 'GTK email settings: original profile receipts across three real keyring processes passed'
