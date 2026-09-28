#!/usr/bin/env bash
# Registers the app with the desktop: launcher entry, rocketvibe:// links.
# The entry runs the release build from this checkout.
#   scripts/install-desktop.sh
set -euo pipefail
cd "$(dirname "$0")/.."
binary="$PWD/target/release/rocket-vibe-gtk"
[ -x "$binary" ] || { echo "build it first: PROFILE=release scripts/build.sh" >&2; exit 1; }
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$apps"
rm -f "$apps/me.barrut.RocketVibe.desktop"
sed "s|^Exec=rocket-vibe-gtk|Exec=$binary|" data/com.rocketvibe.app.desktop > "$apps/com.rocketvibe.app.desktop"
xdg-mime default com.rocketvibe.app.desktop x-scheme-handler/rocketvibe
update-desktop-database "$apps" 2>/dev/null || true
echo "installed $apps/com.rocketvibe.app.desktop"
