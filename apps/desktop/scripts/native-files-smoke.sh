#!/usr/bin/env bash
set -euo pipefail
files_dir=$(mktemp -d /tmp/rv-file-gtk.XXXXXX)
export XDG_RUNTIME_DIR="$files_dir/runtime" XDG_CONFIG_HOME="$files_dir/config" XDG_CACHE_HOME="$files_dir/cache" XDG_DATA_HOME="$files_dir/data"
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
chmod 700 "$XDG_RUNTIME_DIR"
export RV_SMOKE_LOGIN="$RV_FILE_TEST_SERVER|desktop-files|$RV_FILE_TEST_PASSWORD"
export RV_SMOKE_ROOM='Desktop files GTK pilot' RV_SMOKE_NATIVE_FILES=1 RV_SMOKE_NATIVE=1
export GDK_BACKEND=x11 DISPLAY=:99 GSK_RENDERER=cairo GTK_A11Y=none
dbus-run-session -- bash -ec '
  printf "\n" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  Xvfb :99 -screen 0 1280x900x24 >/dev/null 2>&1 &
  for i in {1..50}; do if [ -S /tmp/.X11-unix/X99 ]; then break; fi; sleep 0.1; done
  exec timeout 60s target/debug/rocket-vibe-gtk
'
