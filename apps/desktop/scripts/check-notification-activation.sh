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
portal_test=$(dbus-run-session -- cargo test --locked -p rocket-vibe-gtk --bin rocket-vibe-gtk notifier::portal::tests::portal_requests_serialize_late_add_update_and_withdraw -- --ignored --exact)
printf '%s\n' "$portal_test"
[[ "$portal_test" == *'test result: ok. 1 passed'* ]]
description=$("${action[@]}" org.gtk.Actions.Describe open-message)
printf 'D-Bus notification action: %s\n' "$description"
[[ "$description" == *"(ss)"* ]]
# No credentials or server: a foreign scope must be refused after creating the
# existing window. This checks dispatch, not private navigation or an OS toast.
"${action[@]}" org.gtk.Actions.Activate open-message "[<('rv-native:invalid:room','message')>]" '{}'
reply_description=$("${action[@]}" org.gtk.Actions.Describe reply-native-notification)
[[ "$reply_description" == *"((ss)s)"* ]]
pid_of() { gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.GetConnectionUnixProcessID com.rocketvibe.app; }
first_pid=$(pid_of)
"${action[@]}" org.gtk.Actions.Activate quit '[]' '{}'
for _ in {1..100}; do
  owner=$(gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.NameHasOwner com.rocketvibe.app)
  [[ "$owner" == *false* ]] && break
  sleep 0.02
done
[[ "$owner" == *false* ]]
# The portal sends the target and reply as two values in av. Exercise the
# actual freedesktop ABI against a second cold GTK process, not a warm signal.
key="rv-native:$(printf '%064d' 0):room"
"${action[@]}" org.freedesktop.Application.ActivateAction reply-native-notification "[<('$key','message')>, <'Réponse 🚀'>]" '{}'
second_pid=$(pid_of)
[[ "$first_pid" != "$second_pid" ]]
if "${action[@]}" org.freedesktop.Application.ActivateAction reply-native-notification "[<'bad target'>, <'reply'>]" '{}' >/dev/null 2>&1; then
  printf '%s\n' 'Malformed portal reply was accepted' >&2
  exit 1
fi
"${action[@]}" org.gtk.Actions.Activate quit '[]' '{}'
printf '%s\n' 'Notification action registered and dispatched by a fresh D-Bus process.'
printf '%s\n' 'Portal reply activates a new GTK process with its typed target and input.'
