#!/usr/bin/env bash
# Builds rv-ffi (static library for the app, dynamic one for the bindings'
# metadata) and writes its Swift bindings and C header into the package.
set -euo pipefail
cd "$(dirname "$0")/../.."
cargo build --locked --release -p rv-ffi --lib
dir=${CARGO_TARGET_DIR:-target}/release
dylib=$dir/librv_ffi.so
if [ -f "$dir/librv_ffi.dylib" ]; then dylib=$dir/librv_ffi.dylib; fi
out=$(mktemp -d)
cargo run --locked --release -q -p rv-ffi --bin uniffi-bindgen-swift -- --swift-sources --headers "$dylib" "$out"
mkdir -p macos/Sources/rv_ffiFFI/include macos/Sources/RocketVibeCore
cp "$out/rv_ffiFFI.h" macos/Sources/rv_ffiFFI/include/
cp "$out/rv_ffi.swift" macos/Sources/RocketVibeCore/
rm -rf "$out"
echo "$dir"
