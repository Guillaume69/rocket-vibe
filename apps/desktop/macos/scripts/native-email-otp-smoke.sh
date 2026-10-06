#!/usr/bin/env bash
# Three real Swift processes retain only private metadata in Secret Service.
set -euo pipefail
cd "$(dirname "$0")/.."
export HOME=/tmp/rv-swift-email-otp-keyring
export XDG_RUNTIME_DIR="$HOME/runtime"
export RV_NATIVE_EMAIL_OTP_HOME=/tmp/rv-swift-email-otp-app
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
for phase in login-delivery login-proof reauth-finish; do
  export RV_NATIVE_EMAIL_OTP_PHASE="$phase"
  dbus-run-session -- bash -ec '
    printf "\n" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
    swift test --skip-build --scratch-path .build/linux --filter NativeEmailFactorTests
  '
done
echo 'Swift email OTP: original deliveries and proofs across three real keyring processes passed'
