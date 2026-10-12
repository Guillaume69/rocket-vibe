#!/usr/bin/env bash
# Native Go connector, separate from the Fedora Rust workspace.
#   scripts/build-whatsapp.sh                  Linux helper in target/<profile>/rv-whatsapp
#   TARGET_OS=windows scripts/build-whatsapp.sh  Windows helper (mingw-w64 cross build) rv-whatsapp.exe
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$(cd ../.. && pwd)
if command -v cygpath >/dev/null 2>&1; then repo=$(cygpath -m "$repo"); fi
profile=${PROFILE:-dev}
case "$profile" in dev) output=debug ;; release) output=release ;; *) echo "Unsupported profile" >&2; exit 2 ;; esac
case "${TARGET_OS:-linux}" in linux | windows) ;; *) echo "Unsupported TARGET_OS" >&2; exit 2 ;; esac
docker run --rm -e GOTOOLCHAIN=auto -v rv-whatsapp-go:/go -v "$repo:/src" -w /src/apps/desktop/whatsapp \
  -e OUTPUT="$output" -e TARGET_OS="${TARGET_OS:-linux}" golang:1.25-bookworm bash -ec '
    test -z "$(gofmt -l *.go)"
    go vet -tags sqlite_unlock_notify ./...
    go test -race -tags sqlite_unlock_notify ./...
    mkdir -p "../target/$OUTPUT"
    if [ "$TARGET_OS" = windows ]; then
      apt-get update -qq >/dev/null && apt-get install -y -qq gcc-mingw-w64-x86-64 >/dev/null
      CGO_ENABLED=1 GOOS=windows GOARCH=amd64 CC=x86_64-w64-mingw32-gcc \
        go build -tags sqlite_unlock_notify -trimpath -o "../target/$OUTPUT/rv-whatsapp.exe" .
    else
      go build -tags sqlite_unlock_notify -trimpath -o "../target/$OUTPUT/rv-whatsapp" .
    fi
  '
