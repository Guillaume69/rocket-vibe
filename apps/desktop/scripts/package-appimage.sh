#!/usr/bin/env bash
# Builds the Linux AppImage in pkgforge-dev's Arch Linux image, from this
# checkout: dist/rocket-vibe-desktop-<version>-linux-x86_64.AppImage
#   scripts/package-appimage.sh
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node ../../scripts/version.mjs desktop)
image=ghcr.io/pkgforge-dev/archlinux:latest
docker volume create rv-cargo-arch >/dev/null
docker run --rm -v "$PWD/../..:/repo" -v rv-cargo-arch:/root/.cargo -w /repo/apps/desktop "$image" \
  sh -c "sh scripts/appimage-build.sh '$version' /repo/apps/desktop/dist && chown -R $(id -u):$(id -g) dist target/appimage"
