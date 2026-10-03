#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export RV_FFI_LIB_DIR=${RV_FFI_LIB_DIR:-/workspace/apps/desktop/target/swift-linux/release}
cd macos
dbus-run-session -- bash -ec '
  printf "\n" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  exec swift test --scratch-path .build/linux --filter NativeFilesTests
'
