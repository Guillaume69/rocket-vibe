#!/usr/bin/env bash
# Native Go connector, separate from the Fedora Rust workspace.
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$(cd ../.. && pwd)
if command -v cygpath >/dev/null 2>&1; then repo=$(cygpath -m "$repo"); fi
profile=${PROFILE:-dev}
case "$profile" in dev) output=debug ;; release) output=release ;; *) echo "Unsupported profile" >&2; exit 2 ;; esac
docker run --rm -e GOTOOLCHAIN=auto -v rv-whatsapp-go:/go -v "$repo:/src" -w /src/apps/desktop/whatsapp \
  -e OUTPUT="$output" golang:1.25-bookworm bash -ec '
    test -z "$(gofmt -l *.go)"
    go vet ./...
    go test -race ./...
    mkdir -p "../target/$OUTPUT"
    go build -trimpath -o "../target/$OUTPUT/rv-whatsapp" .
  '

