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
# dbus-daemon looks the user up: the image has no entry for the host's uid.
bus=()
if [ -n "${RV_SMOKE_NOTIFY:-}" ]; then
  bus=(-v /etc/passwd:/etc/passwd:ro)
fi

host_look=()
if [ "${RV_HOST_LOOK:-}" = 1 ]; then
  mkdir -p "$home/.config/gtk-4.0"
  cp ~/.config/gtk-4.0/settings.ini "$home/.config/gtk-4.0/" 2>/dev/null || true
  host_look=(-v /usr/share/icons:/usr/share/icons:ro)
fi

docker run --rm --network host -u "$(id -u):$(id -g)" -v "$PWD:/src" -v "$out:/out" -v "$home:/home/smoke" -w /src \
  "${host_look[@]}" "${bus[@]}" \
  -e HOME=/home/smoke -e LANG=C.UTF-8 -e GDK_BACKEND=x11 -e DISPLAY=:99 -e GSK_RENDERER=cairo -e GTK_A11Y=none \
  -e RV_SMOKE_DELAY_MS="${RV_SMOKE_DELAY_MS:-15000}" \
  -e RV_SMOKE_LOGIN="$server|$user|$password" -e RV_SMOKE_ROOM="$room" -e RV_SMOKE_SEND="$message" \
  -e RV_SMOKE_SHOT="/out/$(basename "$shot")" \
  -e RV_SMOKE_EXPECT="${RV_SMOKE_EXPECT:-}" -e RV_SMOKE_EXPECT_ABSENT="${RV_SMOKE_EXPECT_ABSENT:-}" \
 -e RV_SMOKE_SIZE="${RV_SMOKE_SIZE:-}" -e RV_SMOKE_REENTER="${RV_SMOKE_REENTER:-}" -e RV_SMOKE_NAV="${RV_SMOKE_NAV:-}" -e RV_SMOKE_DRAFT_TEXT="${RV_SMOKE_DRAFT_TEXT:-}" -e RV_SMOKE_VIDEO="${RV_SMOKE_VIDEO:-}" -e RV_SMOKE_FOLD="${RV_SMOKE_FOLD:-}" -e RV_SMOKE_JUMP="${RV_SMOKE_JUMP:-}" -e RV_SMOKE_JUMP_CLICK_MS="${RV_SMOKE_JUMP_CLICK_MS:-}" -e RV_SMOKE_EDIT="${RV_SMOKE_EDIT:-}" -e RV_SMOKE_EDIT_SAVE_MS="${RV_SMOKE_EDIT_SAVE_MS:-}" -e RV_SMOKE_COMPOSER="${RV_SMOKE_COMPOSER:-}" -e RV_SMOKE_ACTIONS="${RV_SMOKE_ACTIONS:-}" -e RV_SMOKE_DRAFTS="${RV_SMOKE_DRAFTS:-}" -e RV_SMOKE_FILES="${RV_SMOKE_FILES:-}" -e RV_SMOKE_UPLOAD="${RV_SMOKE_UPLOAD:-}" -e RV_SMOKE_UPLOAD_HOLD="${RV_SMOKE_UPLOAD_HOLD:-}" -e RV_SMOKE_SPOTLIGHT="${RV_SMOKE_SPOTLIGHT:-}" -e RV_SMOKE_DETAILS="${RV_SMOKE_DETAILS:-}" -e RV_SMOKE_NOTIFY="${RV_SMOKE_NOTIFY:-}" -e RV_SMOKE_SECOND="${RV_SMOKE_SECOND:-}" -e RV_SMOKE_E2E="${RV_SMOKE_E2E:-}" -e RV_SMOKE_VOICE="${RV_SMOKE_VOICE:-}" -e RV_SMOKE_OPEN="${RV_SMOKE_OPEN:-}" -e RV_AUDIO_SOURCE="${RV_AUDIO_SOURCE:-audiotestsrc is-live=true}" -e RV_BIN="${RV_BIN:-target/debug/rocket-vibe-gtk}" -e LLVM_PROFILE_FILE="${RV_PROFILE:-/dev/null}" \
  rocket-vibe-rs-build bash -c 'Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 & sleep 1
    if [ -n "$RV_SMOKE_NOTIFY" ]; then exec dbus-run-session -- "./$RV_BIN" $RV_SMOKE_OPEN; else exec "./$RV_BIN" $RV_SMOKE_OPEN; fi'
