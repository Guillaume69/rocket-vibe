#!/usr/bin/env bash
# Build, lint and test inside the Fedora 44 image. The binary lands in
# target/ (or RV_CARGO_TARGET_DIR) and runs on a host with GTK 4.22/libadwaita 1.9.
set -euo pipefail
cd "$(dirname "$0")/.."

image=rocket-vibe-rs-build
docker build -q -t "$image" docker >/dev/null
docker volume create rv-cargo >/dev/null
docker run --rm -v rv-cargo:/cargo "$image" chown "$(id -u):$(id -g)" /cargo

profile=${PROFILE:-dev}
repo=$(cd ../.. && pwd)
# Keep large disposable artifacts off a constrained worktree drive when requested.
target_mount=()
if [[ -n ${RV_CARGO_TARGET_DIR:-} ]]; then
  mkdir -p "$RV_CARGO_TARGET_DIR"
  target_mount=(-v "$RV_CARGO_TARGET_DIR:/workspace/apps/desktop/target")
fi
docker run --rm -u "$(id -u):$(id -g)" -v "$repo:/workspace" -v rv-cargo:/cargo "${target_mount[@]}" -w /workspace/apps/desktop -e PROFILE="$profile" -e CARGO_BUILD_JOBS -e CARGO_INCREMENTAL "$image" bash -c '
  set -euo pipefail
  cargo fmt --all -- --check
  cargo clippy --workspace --all-targets --profile "$PROFILE" -- -D warnings
  cargo test --workspace --profile "$PROFILE"
  cargo build --workspace --profile "$PROFILE"
'
