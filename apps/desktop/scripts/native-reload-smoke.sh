#!/usr/bin/env bash
# The GTK reload benchmark against the native pilot: the peer
# (rv-core example native-reload-peer) fills a room with history and a dozen
# others, GTK opens it with the reload trace on, the peer sends a timed burst
# across the rooms. Measures land in /workspace/artifacts/native-reload.log;
# scripts/native-reload-summary.sh turns them into Markdown.
set -euo pipefail
bench=$(mktemp -d /tmp/rv-reload.XXXXXX)
export XDG_RUNTIME_DIR="$bench/runtime" XDG_CONFIG_HOME="$bench/config" XDG_CACHE_HOME="$bench/cache" XDG_DATA_HOME="$bench/data"
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
chmod 700 "$XDG_RUNTIME_DIR"
export RV_RELOAD_DIR="$bench/markers"
mkdir -p "$RV_RELOAD_DIR" /workspace/artifacts
log=/workspace/artifacts/native-reload.log

target/debug/examples/native-reload-peer &
peer=$!
for _ in $(seq 1 1800); do
  [ -f "$RV_RELOAD_DIR/ready" ] && break
  if ! kill -0 "$peer" 2>/dev/null; then wait "$peer"; exit 1; fi
  sleep 0.1
done
[ -f "$RV_RELOAD_DIR/ready" ] || { echo "reload peer never filled the rooms" >&2; exit 1; }

export RV_SMOKE_LOGIN="$RV_PEER_URL|reload-gtk|$RV_PEER_PASSWORD"
export RV_SMOKE_ROOM='Reload plain' RV_SMOKE_NATIVE=1 RV_SMOKE_NATIVE_RELOAD="$RV_RELOAD_DIR"
export G_MESSAGES_DEBUG=rocket-vibe-reload
export GDK_BACKEND=x11 DISPLAY=:99 GSK_RENDERER=cairo GTK_A11Y=none
status=0
dbus-run-session -- bash -ec '
  printf "\n" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  Xvfb :99 -screen 0 1280x900x24 >/dev/null 2>&1 &
  for i in {1..50}; do if [ -S /tmp/.X11-unix/X99 ]; then break; fi; sleep 0.1; done
  exec timeout 300s target/debug/rocket-vibe-gtk
' >"$log" 2>&1 || status=$?
wait "$peer" || status=$?
grep -E '^smoke:' "$log" || true
exit "$status"
