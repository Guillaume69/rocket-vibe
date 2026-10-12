#!/usr/bin/env bash
# Inside dbus-run-session: this session's own Secret Service, unlocked, owning
# its bus name before the app runs. Otherwise the app's first call activates a
# second daemon that never got the password, and the saved accounts vanish.
set -euo pipefail
running() { grep -qsx gnome-keyring-d /proc/[0-9]*/comm; }
owned() {
  [[ $(dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
    org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets 2>/dev/null) == *'boolean true'* ]]
}
for _ in $(seq 100); do
  running || break
  sleep 0.1
done
if [ -n "${XDG_RUNTIME_DIR:-}" ]; then rm -rf "$XDG_RUNTIME_DIR/keyring"; fi
for _ in 1 2 3; do
  printf '\n' | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  for _ in $(seq 50); do
    if owned; then exit 0; fi
    sleep 0.1
  done
done
echo 'unlock-keyring: the Secret Service did not start' >&2
exit 1
