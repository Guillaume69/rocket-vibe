#!/usr/bin/env bash
# The rv-whatsapp helper (crates/rv-whatsapp/engine), apart from the Fedora
# GTK workspace: its own Cargo workspace, checked and built in a Rust container.
#   scripts/build-whatsapp.sh                  Linux helper in target/<profile>/rv-whatsapp
#   TARGET_OS=windows scripts/build-whatsapp.sh  Windows helper (mingw-w64 cross build) rv-whatsapp.exe
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$(cd ../.. && pwd)
if command -v cygpath >/dev/null 2>&1; then repo=$(cygpath -m "$repo"); fi
profile=${PROFILE:-dev}
case "$profile" in dev) output=debug flag= ;; release) output=release flag=--release ;; *) echo "Unsupported profile" >&2; exit 2 ;; esac
case "${TARGET_OS:-linux}" in linux | windows) ;; *) echo "Unsupported TARGET_OS" >&2; exit 2 ;; esac
docker run --rm -v rv-whatsapp-cargo:/usr/local/cargo/registry -v rv-whatsapp-target:/target -v "$repo:/src" \
  -w /src/crates/rv-whatsapp -e OUTPUT="$output" -e FLAG="$flag" -e TARGET_OS="${TARGET_OS:-linux}" \
  -e CARGO_TARGET_DIR=/target rust:1.97-bookworm bash -ec '
    rustup component add rustfmt clippy >/dev/null 2>&1
    cargo fmt -p rv-whatsapp-engine --check
    cargo clippy --locked -p rv-whatsapp-engine --all-targets -- -D warnings
    cargo test --locked -p rv-whatsapp-engine
    mkdir -p "/src/apps/desktop/target/$OUTPUT"
    if [ "$TARGET_OS" = windows ]; then
      apt-get update -qq >/dev/null && apt-get install -y -qq gcc-mingw-w64-x86-64 >/dev/null
      rustup target add x86_64-pc-windows-gnu >/dev/null 2>&1
      CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc \
        cargo build $FLAG --locked -p rv-whatsapp-engine --bin rv-whatsapp --target x86_64-pc-windows-gnu
      cp "/target/x86_64-pc-windows-gnu/$OUTPUT/rv-whatsapp.exe" "/src/apps/desktop/target/$OUTPUT/"
    else
      cargo build $FLAG --locked -p rv-whatsapp-engine --bin rv-whatsapp
      cp "/target/$OUTPUT/rv-whatsapp" "/src/apps/desktop/target/$OUTPUT/"
    fi
  '
