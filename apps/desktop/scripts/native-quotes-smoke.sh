#!/usr/bin/env bash
# Exercise the existing GTK composer and cards; no screenshot is produced.
set -euo pipefail
quote_dir=$(mktemp -d /tmp/rv-quote-gtk.XXXXXX)
export XDG_RUNTIME_DIR="$quote_dir/runtime" XDG_CONFIG_HOME="$quote_dir/config" XDG_CACHE_HOME="$quote_dir/cache" XDG_DATA_HOME="$quote_dir/data"
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
chmod 700 "$XDG_RUNTIME_DIR"
export RV_SMOKE_LOGIN="$RV_PEER_URL|desktop|$RV_PEER_PASSWORD"
export RV_SMOKE_ROOM='Native quote composer pilot' RV_SMOKE_QUOTES=1 RV_SMOKE_NATIVE=1
export GDK_BACKEND=x11 DISPLAY=:99 GSK_RENDERER=cairo GTK_A11Y=none
dbus-run-session -- bash -ec '
  printf "\n" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  Xvfb :99 -screen 0 1280x900x24 >/dev/null 2>&1 &
  for i in {1..50}; do if [ -S /tmp/.X11-unix/X99 ]; then break; fi; sleep 0.1; done
  exec timeout 90s target/debug/rocket-vibe-gtk
'
