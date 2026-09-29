#!/usr/bin/env bash
# Builds and tests what of the macOS package builds without AppKit, in a
# Swift container: every target but the SwiftUI app.
set -euo pipefail
cd "$(dirname "$0")/../.."
image=rocket-vibe-swift
docker build -q -t "$image" macos/docker > /dev/null
docker volume create rv-swift-cargo > /dev/null
docker run --rm -v rv-swift-cargo:/cargo "$image" chown "$(id -u):$(id -g)" /cargo
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/src" -v rv-swift-cargo:/cargo -w /src \
  -e CARGO_HOME=/cargo -e CARGO_TARGET_DIR=/src/target/swift-linux -e CC=clang -e CXX=clang++ -e CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=clang -e HOME=/tmp --network host \
  -e RV_TEST_SERVER "$image" bash -c '
  set -euo pipefail
  export PATH=/opt/cargo/bin:$PATH RUSTUP_HOME=/opt/rustup
  lib=$(macos/scripts/generate.sh | tail -1)
  cd macos
  RV_FFI_LIB_DIR=$lib swift build --scratch-path .build/linux
'
