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
export RV_SMOKE_SIZE=435x760
for phase in login-delivery login-proof reauth-finish; do
  export RV_SMOKE_EMAIL_OTP_PHASE="$phase"
  export RV_SMOKE_NATIVE=1 RV_SMOKE_DELAY_MS=35000
  if [ "$phase" = reauth-finish ]; then unset RV_SMOKE_LOGIN; else
    export RV_SMOKE_LOGIN='http://factor-proxy:3401|gtk-email|native-pilot-test-password'
  fi
  export RV_SMOKE_SHOT=/workspace/artifacts/native-desktop-email-otp.png
  if [ "$phase" = login-delivery ]; then
    export RV_SMOKE_NATIVE=0 RV_SMOKE_DELAY_MS=5000
    export RV_SMOKE_SHOT=/workspace/artifacts/native-desktop-email-otp-login.png
  fi
  dbus-run-session -- bash -ec '
    printf "\n" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
    target/debug/rocket-vibe-gtk
  '
done
echo 'GTK email OTP: original deliveries and proofs across three real keyring processes passed'
