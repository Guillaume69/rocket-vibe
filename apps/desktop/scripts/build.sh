#!/usr/bin/env bash
# Build, lint and test inside the Fedora 44 image. The binary lands in
# target/ and runs on the host, which has the same GTK 4.22 and libadwaita 1.9.
set -euo pipefail
cd "$(dirname "$0")/.."

image=rocket-vibe-rs-build
docker build -q -t "$image" -f docker/Dockerfile docker >/dev/null
docker volume create rv-cargo >/dev/null
build_user="$(id -u):$(id -g)"
if command -v cygpath >/dev/null 2>&1; then build_user=0:0; fi
docker run --rm -v rv-cargo:/cargo "$image" chown "$build_user" /cargo

profile=${PROFILE:-dev}
repo=$(cd ../.. && pwd)
if command -v cygpath >/dev/null 2>&1; then repo=$(cygpath -m "$repo"); fi
target_mount=()
if [[ -n "${RV_BUILD_TARGET_DIR:-}" ]]; then target_mount=(-v "$RV_BUILD_TARGET_DIR:/workspace/apps/desktop/target"); fi
docker run --rm -u "$build_user" -v "$repo:/workspace" -v rv-cargo:/cargo "${target_mount[@]}" -w /workspace/apps/desktop \
  -e PROFILE="$profile" -e CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" \
  -e CARGO_PROFILE_DEV_DEBUG -e CARGO_PROFILE_TEST_DEBUG "$image" bash -c '
  set -euo pipefail
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets --profile "$PROFILE" -- -D warnings
  cargo test --workspace --profile "$PROFILE"
  cargo build --workspace --profile "$PROFILE"
'
