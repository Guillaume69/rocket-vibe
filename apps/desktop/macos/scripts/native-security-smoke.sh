#!/usr/bin/env bash
# Three real Swift test processes share only an actual Secret Service keyring.
set -euo pipefail
cd "$(dirname "$0")/.."
export HOME=/tmp/rv-swift-security-keyring
export XDG_RUNTIME_DIR="$HOME/runtime"
export RV_NATIVE_SECURITY_TEST_HOME=/tmp/rv-swift-security-app
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
for phase in proof-regenerate restart-ack-disable removal-restart-ack-disable; do
  export RV_NATIVE_SECURITY_TEST_PHASE="$phase"
  dbus-run-session -- bash -ec '
    printf "\n" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
    swift test --skip-build --scratch-path .build/linux --filter NativeSecurityTests
  '
done
echo 'Swift security: identity proof, mail verification/removal, factor ACK recovery, view guards and private receipts after process restart passed'
