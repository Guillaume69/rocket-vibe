#!/usr/bin/env bash
# Run inside the Fedora build image. Exercise a real D-Bus service launch,
# before a normal app activation or account selection, in disposable XDG dirs.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${1:-}" != --inside ]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  export XDG_DATA_HOME="$work/data" XDG_CONFIG_HOME="$work/config" XDG_CACHE_HOME="$work/cache"
  export XDG_DATA_DIRS="$XDG_DATA_HOME:/usr/local/share:/usr/share"
  mkdir -p "$XDG_DATA_HOME/dbus-1/services" "$XDG_DATA_HOME/applications"
  sed "s|^Exec=.*|Exec=\"$PWD/target/debug/rocket-vibe-gtk\" --gapplication-service|" data/com.rocketvibe.app.service > "$XDG_DATA_HOME/dbus-1/services/com.rocketvibe.app.service"
  cp data/com.rocketvibe.app.desktop "$XDG_DATA_HOME/applications/"
  exec_status=0
  xvfb-run -a dbus-run-session -- bash "$0" --inside || exec_status=$?
  exit "$exec_status"
fi
action=(gdbus call --session --dest com.rocketvibe.app --object-path /com/rocketvibe/app --method)
description=$("${action[@]}" org.gtk.Actions.Describe open-message)
printf 'D-Bus notification action: %s\n' "$description"
[[ "$description" == *"(ss)"* ]]
# No credentials or server: a foreign scope must be refused after creating the
# existing window. This checks dispatch, not private navigation or an OS toast.
"${action[@]}" org.gtk.Actions.Activate open-message "[<('rv-native:invalid:room','message')>]" '{}'
"${action[@]}" org.gtk.Actions.Activate quit '[]' '{}'
printf '%s\n' 'Notification action registered and dispatched by a fresh D-Bus process.'
