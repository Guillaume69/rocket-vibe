#!/usr/bin/env bash
# Builds the shippable Linux rv-screen-audio in ubuntu:24.04: the PipeWire
# bindings need headers newer than 22.04's 0.3.48, while the binary only calls
# functions libpipewire 0.3 already had, so it runs on older systems too. The
# glibc it needs is printed. Output: apps/desktop/dist/voice/rv-screen-audio,
# beside rv-voice (build-linux.sh).
#
#   apps/desktop/voice/scripts/build-screen-audio-linux.sh
#
# Caches cargo downloads and the target dir in the docker volume rv-voice-cargo.
set -euo pipefail
desktop=$(cd "$(dirname "$0")/../.." && pwd)
if command -v cygpath > /dev/null; then
    desktop=$(cygpath -m "$desktop")
    export MSYS_NO_PATHCONV=1
fi
mkdir -p "$desktop/dist/voice"
docker run --rm -v "$desktop:/desktop" -v rv-voice-cargo:/cache ubuntu:24.04 bash -euo pipefail -c '
export DEBIAN_FRONTEND=noninteractive CARGO_HOME=/cache/cargo RUSTUP_HOME=/cache/rustup CARGO_TARGET_DIR=/cache/target-noble CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-6}
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl build-essential pkg-config clang libpipewire-0.3-dev > /dev/null
[ -x "$CARGO_HOME/bin/cargo" ] || curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path > /dev/null
export PATH="$CARGO_HOME/bin:$PATH"
cd /desktop/voice
cargo build --release --locked -p rv-screen-audio
cp "$CARGO_TARGET_DIR/release/rv-screen-audio" /desktop/dist/voice/
objdump -T /desktop/dist/voice/rv-screen-audio | grep -o "GLIBC_[0-9.]*" | sort -uV | tail -1
'
ls -l "$desktop/dist/voice/rv-screen-audio"
