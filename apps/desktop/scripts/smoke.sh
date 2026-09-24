#!/usr/bin/env bash
# Headless end-to-end run in the build image, under Xvfb: logs in, opens a
# room, sends a message and saves a screenshot. Needs a reachable server.
#   scripts/smoke.sh <server> <user> <password> <room> <out.png> [message]
set -euo pipefail
cd "$(dirname "$0")/.."
server=$1 user=$2 password=$3 room=$4 shot=$5 message=${6:-}
out=$(cd "$(dirname "$shot")" && pwd)
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT

# RV_HOST_LOOK=1 renders with this machine's icon themes and GTK settings,
# which is what a native run shows (the image only carries Adwaita).
host_look=()
if [ "${RV_HOST_LOOK:-}" = 1 ]; then
  mkdir -p "$home/.config/gtk-4.0"
  cp ~/.config/gtk-4.0/settings.ini "$home/.config/gtk-4.0/" 2>/dev/null || true
  host_look=(-v /usr/share/icons:/usr/share/icons:ro)
fi

docker run --rm --network host -u "$(id -u):$(id -g)" -v "$PWD:/src" -v "$out:/out" -v "$home:/home/smoke" -w /src \
  "${host_look[@]}" \
  -e HOME=/home/smoke -e LANG=C.UTF-8 -e GDK_BACKEND=x11 -e DISPLAY=:99 -e GSK_RENDERER=cairo -e GTK_A11Y=none \
  -e RV_SMOKE_DELAY_MS="${RV_SMOKE_DELAY_MS:-15000}" \
  -e RV_SMOKE_LOGIN="$server|$user|$password" -e RV_SMOKE_ROOM="$room" -e RV_SMOKE_SEND="$message" \
  -e RV_SMOKE_SHOT="/out/$(basename "$shot")" \
  -e RV_SMOKE_EXPECT="${RV_SMOKE_EXPECT:-}" -e RV_SMOKE_EXPECT_ABSENT="${RV_SMOKE_EXPECT_ABSENT:-}" \
  -e RV_SMOKE_SIZE="${RV_SMOKE_SIZE:-}" -e RV_BIN="${RV_BIN:-target/debug/rocket-vibe-gtk}" -e LLVM_PROFILE_FILE="${RV_PROFILE:-/dev/null}" \
  rocket-vibe-rs-build bash -c 'Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 & sleep 1; "./$RV_BIN"'
