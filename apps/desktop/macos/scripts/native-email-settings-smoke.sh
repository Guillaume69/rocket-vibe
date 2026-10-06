#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export HOME=/tmp/rv-swift-email-settings-keyring
export XDG_RUNTIME_DIR="$HOME/runtime"
export RV_NATIVE_EMAIL_SETTINGS_HOME=/tmp/rv-swift-email-settings-app
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
for phase in enable resume-disable resume-disabled; do
  export RV_NATIVE_EMAIL_SETTINGS_PHASE="$phase"
  dbus-run-session -- bash -ec '
    printf "\n" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
    swift test --skip-build --scratch-path .build/linux --filter NativeEmailSettingsTests
  '
done
echo 'Swift email settings: original profile receipts across three real keyring processes passed'
