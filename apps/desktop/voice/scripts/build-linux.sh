#!/usr/bin/env bash
# Builds the shippable Linux rv-voice in ubuntu:22.04 (glibc 2.35), so it runs on
# any distribution at least that recent: a binary built in the Fedora image needs
# glibc 2.43. webrtc-sys needs clang >= 21 (libwebrtc's hermetic libc++), taken
# from apt.llvm.org. Output: apps/desktop/dist/voice/rv-voice, where the Linux
# packaging scripts (scripts/appimage-build.sh) take it, beside rv-screen-audio
# (build-screen-audio-linux.sh).
#
#   apps/desktop/voice/scripts/build-linux.sh
#
# Caches cargo downloads and the target dir in the docker volume rv-voice-cargo.
set -euo pipefail
desktop=$(cd "$(dirname "$0")/../.." && pwd)
if command -v cygpath > /dev/null; then
    desktop=$(cygpath -m "$desktop")
    export MSYS_NO_PATHCONV=1
fi
mkdir -p "$desktop/dist/voice"
docker run --rm -v "$desktop:/desktop" -v rv-voice-cargo:/cache ubuntu:22.04 bash -euo pipefail -c '
export DEBIAN_FRONTEND=noninteractive CARGO_HOME=/cache/cargo RUSTUP_HOME=/cache/rustup CARGO_TARGET_DIR=/cache/target CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-6}
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg build-essential pkg-config libglib2.0-dev > /dev/null
curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key | gpg --dearmor -o /usr/share/keyrings/llvm.gpg
echo "deb [signed-by=/usr/share/keyrings/llvm.gpg] http://apt.llvm.org/jammy/ llvm-toolchain-jammy-21 main" > /etc/apt/sources.list.d/llvm.list
apt-get update -qq
apt-get install -y -qq --no-install-recommends clang-21 > /dev/null
ln -sf /usr/bin/clang-21 /usr/bin/clang
ln -sf /usr/bin/clang++-21 /usr/bin/clang++
[ -x "$CARGO_HOME/bin/cargo" ] || curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path > /dev/null
export PATH="$CARGO_HOME/bin:$PATH"
cd /desktop/voice
cargo build --release --locked -p rv-voice
cp "$CARGO_TARGET_DIR/release/rv-voice" /desktop/dist/voice/rv-voice
objdump -T /desktop/dist/voice/rv-voice | grep -o "GLIBC_[0-9.]*" | sort -uV | tail -1
'
ls -l "$desktop/dist/voice/rv-voice"
