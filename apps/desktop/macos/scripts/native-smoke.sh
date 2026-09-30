#!/usr/bin/env bash
# The actual Swift view models, a native server and a fresh Secret Service keyring.
set -euo pipefail
cd "$(dirname "$0")/.."
export HOME=/tmp/rv-swift-native-keyring
export XDG_RUNTIME_DIR="$HOME/runtime"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
dbus-run-session -- bash -ec '
  printf "\n" | gnome-keyring-daemon --unlock --components=secrets > /dev/null
  swift test --skip-build --scratch-path .build/linux --filter NativeProviderTests
'
