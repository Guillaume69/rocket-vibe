#!/usr/bin/env bash
# Builds and tests what of the macOS package builds without AppKit, in a
# Swift container: every target but the SwiftUI app.
set -euo pipefail
cd "$(dirname "$0")/../.."
image=rocket-vibe-swift
repo=$(cd ../.. && pwd)
docker build -q -t "$image" macos/docker > /dev/null
docker volume create rv-swift-cargo > /dev/null
build_user="$(id -u):$(id -g)"
# Rootless Docker maps the host user to container root: bind mounts need 0:0.
if docker info -f '{{range .SecurityOptions}}{{println .}}{{end}}' 2>/dev/null | grep -q rootless; then build_user=0:0; fi
docker run --rm -v rv-swift-cargo:/cargo "$image" chown "$build_user" /cargo
docker run --rm -u "$build_user" -v "$repo:/workspace" -v rv-swift-cargo:/cargo -w /workspace/apps/desktop \
  -e CARGO_HOME=/cargo -e CARGO_TARGET_DIR=/workspace/apps/desktop/target/swift-linux -e CC=clang -e CXX=clang++ -e CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=clang -e HOME=/tmp --network host \
  -e RV_TEST_SERVER "$image" bash -c '
  set -euo pipefail
  export PATH=/opt/cargo/bin:$PATH RUSTUP_HOME=/opt/rustup
  lib=$(macos/scripts/generate.sh | tail -1)
  cd macos
  RV_FFI_LIB_DIR=$lib swift build --scratch-path .build/linux
  RV_FFI_LIB_DIR=$lib swift test --scratch-path .build/linux
'
