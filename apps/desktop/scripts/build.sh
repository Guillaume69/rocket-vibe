#!/usr/bin/env bash
# Build, lint and test inside the Fedora 44 image. The binary lands in
# target/ and runs on the host, which has the same GTK 4.22 and libadwaita 1.9.
set -euo pipefail
cd "$(dirname "$0")/.."

image=rocket-vibe-rs-build
docker build -q -t "$image" docker >/dev/null
docker volume create rv-cargo >/dev/null
docker run --rm -v rv-cargo:/cargo "$image" chown "$(id -u):$(id -g)" /cargo

profile=${PROFILE:-dev}
repo=$(cd ../.. && pwd)
docker run --rm -u "$(id -u):$(id -g)" -v "$repo:/workspace" -v rv-cargo:/cargo -w /workspace/apps/desktop \
  -e PROFILE="$profile" -e CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" \
  -e CARGO_PROFILE_DEV_DEBUG -e CARGO_PROFILE_TEST_DEBUG "$image" bash -c '
  set -euo pipefail
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets --profile "$PROFILE" -- -D warnings
  cargo test --workspace --profile "$PROFILE"
  cargo build --workspace --profile "$PROFILE"
'
