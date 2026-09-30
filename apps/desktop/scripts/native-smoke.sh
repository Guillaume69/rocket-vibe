#!/usr/bin/env bash
# Inside the Fedora build image; launched by docker/compose.native-pilot.yml.
set -euo pipefail
mkdir -p "$HOME" ../../artifacts
target/debug/examples/native-smoke
Xvfb :99 -screen 0 1280x900x24 >/dev/null 2>&1 &
display_pid=$!
trap 'kill "$display_pid" 2>/dev/null || true' EXIT
sleep 1
export GDK_BACKEND=x11 DISPLAY=:99 GSK_RENDERER=cairo GTK_A11Y=none
export RV_SMOKE_NATIVE=1 RV_SMOKE_DELAY_MS=15000
export RV_SMOKE_LOGIN="$RV_PEER_URL|desktop|$RV_PEER_PASSWORD"
export RV_SMOKE_ROOM=native-pilot RV_SMOKE_SEND='Message du bureau GTK'
export RV_SMOKE_EXPECT='Message du mobile|Message du bureau GTK|Réponse du mobile au bureau GTK'
export RV_SMOKE_SHOT=/workspace/artifacts/native-desktop.png
dbus-run-session -- target/debug/rocket-vibe-gtk
export HOME=/tmp/rv-native-pilot-narrow
mkdir -p "$HOME"
export RV_SMOKE_SIZE=435x760 RV_SMOKE_SEND=''
export RV_SMOKE_SHOT=/workspace/artifacts/native-desktop-narrow.png
dbus-run-session -- target/debug/rocket-vibe-gtk
