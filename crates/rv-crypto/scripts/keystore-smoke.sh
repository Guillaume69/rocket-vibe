#!/usr/bin/env bash
# Linux only: an isolated container, disposable Secret Service and actual
# process termination between the SQLite commit and the platform checkpoint.
set -euo pipefail
: "${RV_CRYPTO_SMOKE_BINARY:?prebuilt protected_smoke binary required}"
crypto_smoke_root=$(mktemp -d)
trap 'rm -rf -- "$crypto_smoke_root"' EXIT
export XDG_CONFIG_HOME="$crypto_smoke_root/config"
export XDG_DATA_HOME="$crypto_smoke_root/data"
export XDG_CACHE_HOME="$crypto_smoke_root/cache"
export XDG_RUNTIME_DIR="$crypto_smoke_root/runtime"
export RV_CRYPTO_SMOKE_DIRECTORY="$crypto_smoke_root/vault"
export RV_CRYPTO_SMOKE_READY="$crypto_smoke_root/ready"
mkdir -m 700 "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
dbus-run-session -- bash -ec '
  printf "\n" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  "$RV_CRYPTO_SMOKE_BINARY" initialize
  "$RV_CRYPTO_SMOKE_BINARY" hold-checkpoint > "$RV_CRYPTO_SMOKE_READY" &
  crypto_smoke_pid=$!
  trap '\''kill "$crypto_smoke_pid" 2>/dev/null || true; wait "$crypto_smoke_pid" 2>/dev/null || true'\'' EXIT
  for attempt in {1..100}; do
    if grep -q "protected-write-at-boundary" "$RV_CRYPTO_SMOKE_READY"; then break; fi
    if ! kill -0 "$crypto_smoke_pid" 2>/dev/null; then cat "$RV_CRYPTO_SMOKE_READY"; exit 1; fi
    sleep 0.05
  done
  grep -q "protected-write-at-boundary" "$RV_CRYPTO_SMOKE_READY"
  "$RV_CRYPTO_SMOKE_BINARY" busy
  kill -KILL "$crypto_smoke_pid"
  crypto_smoke_status=0
  wait "$crypto_smoke_pid" || crypto_smoke_status=$?
  test "$crypto_smoke_status" = 137
  trap - EXIT
'
dbus-run-session -- bash -ec '
  printf "\n" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  "$RV_CRYPTO_SMOKE_BINARY" recover
  "$RV_CRYPTO_SMOKE_BINARY" retire
'
echo 'Protected crypto: real Secret Service restart, OS lease, forced crash, checkpoint recovery and retirement passed'
