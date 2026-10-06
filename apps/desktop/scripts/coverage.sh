#!/usr/bin/env bash
# Line coverage of the workspace, in the build image.
#   scripts/coverage.sh           unit and integration tests
#   scripts/coverage.sh --e2e     plus an instrumented scripts/e2e.sh run (needs the seeded bench)
#   HTML=1 scripts/coverage.sh    also writes target/llvm-cov/html
set -euo pipefail
cd "$(dirname "$0")/.."
image=rocket-vibe-rs-build
repo=$(cd ../.. && pwd)
in_image() {
  docker run --rm --network host -u "$(id -u):$(id -g)" -v "$repo:/workspace" -v rv-cargo:/cargo -w /workspace/apps/desktop "$image" bash -c "
    set -euo pipefail
    eval \"\$(cargo llvm-cov show-env --export-prefix 2>/dev/null)\"
    $1"
}

in_image 'cargo llvm-cov clean --workspace; cargo test -q --workspace >/dev/null; cargo build -q -p rocket-vibe-gtk'
if [ "${1:-}" = "--e2e" ]; then
  bin=$(in_image 'echo "${CARGO_LLVM_COV_TARGET_DIR:-$CARGO_TARGET_DIR}/debug/rocket-vibe-gtk" | sed "s|^/workspace/apps/desktop/||"')
  profile=$(in_image 'echo "$LLVM_PROFILE_FILE"')
  RV_BIN="$bin" RV_PROFILE="$profile" scripts/e2e.sh
fi
in_image 'cargo llvm-cov report --summary-only --ignore-filename-regex "rustc-|/library/std/"'
if [ "${HTML:-}" = 1 ]; then
  in_image 'cargo llvm-cov report --html --ignore-filename-regex "rustc-|/library/std/"' >/dev/null
  echo "HTML report: target/llvm-cov/html/index.html"
fi
