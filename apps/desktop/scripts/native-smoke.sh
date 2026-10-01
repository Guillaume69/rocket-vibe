#!/usr/bin/env bash
# Inside the Fedora build image; launched by docker/compose.native-pilot.yml.
set -euo pipefail
mkdir -p "$HOME" ../../artifacts
export XDG_RUNTIME_DIR="$HOME/runtime"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
run_with_keyring() {
  local log
  log=$(mktemp)
  if ! dbus-run-session -- bash -ec '
    printf "\n" | gnome-keyring-daemon --unlock --components=secrets > /dev/null
    target/debug/rocket-vibe-gtk
  ' > "$log" 2>&1; then
    cat "$log"
    rm -f "$log"
    return 1
  fi
  cat "$log"
  if grep -Eq 'Keychain (write failed|write timed out|did not answer)' "$log"; then
    rm -f "$log"
    return 1
  fi
  rm -f "$log"
}
target/debug/examples/native-smoke
Xvfb :99 -screen 0 1280x900x24 >/dev/null 2>&1 &
display_pid=$!
trap 'kill "$display_pid" 2>/dev/null || true' EXIT
sleep 1
export GDK_BACKEND=x11 DISPLAY=:99 GSK_RENDERER=cairo GTK_A11Y=none
export RV_SMOKE_NATIVE=1 RV_SMOKE_DELAY_MS=15000
export RV_SMOKE_LOGIN="$RV_PEER_URL|desktop|$RV_PEER_PASSWORD"
export RV_SMOKE_ROOM=native-pilot RV_SMOKE_SEND='Message du bureau GTK'
export RV_SMOKE_EXPECT='Message du mobile|Message du bureau GTK|Réponse du mobile au bureau GTK'
export RV_SMOKE_SHOT=/workspace/artifacts/native-desktop.png
run_with_keyring
# Reopen the same persisted account, under a fresh bus/keyring process. No login
# injection: the narrow run must read its native identity/token from Secret Service.
unset RV_SMOKE_LOGIN
export RV_SMOKE_SIZE=435x760 RV_SMOKE_SEND=''
export RV_SMOKE_SHOT=/workspace/artifacts/native-desktop-narrow.png
run_with_keyring
# Exercise the existing inline editor, including its Up-arrow path and save event.
export RV_SMOKE_SIZE=1280x900 RV_SMOKE_EDIT='GTK native edit'
export RV_SMOKE_EXPECT='GTK native edit after' RV_SMOKE_EXPECT_ABSENT='GTK native edit before'
export RV_SMOKE_SHOT=/workspace/artifacts/native-desktop-edit.png
run_with_keyring
echo 'GTK native account: saved session resumed from real Secret Service after process restart'
# Existing settings -> devices -> current device name, through the real widgets.
unset RV_SMOKE_EDIT
export RV_SMOKE_DEVICES=1 RV_SMOKE_EXPECT='' RV_SMOKE_EXPECT_ABSENT=''
export RV_SMOKE_SHOT=/workspace/artifacts/native-desktop-devices.png
run_with_keyring
if [[ -n "${RV_NATIVE_INVITATION_FILE:-}" ]]; then
  # A fresh account, through the existing sign-in form and real Secret Service.
  unset RV_SMOKE_DEVICES RV_SMOKE_EDIT RV_SMOKE_ROOM
  export HOME=/tmp/rv-native-signup-home XDG_RUNTIME_DIR=/tmp/rv-native-signup-home/runtime
  mkdir -p "$XDG_RUNTIME_DIR"
  chmod 700 "$XDG_RUNTIME_DIR"
  export RV_SMOKE_LOGIN="$RV_PEER_URL|gtk-invited|$RV_PEER_PASSWORD"
  export RV_SMOKE_INVITATION_FILE="$RV_NATIVE_INVITATION_FILE"
  export RV_SMOKE_SEND='' RV_SMOKE_EXPECT='' RV_SMOKE_EXPECT_ABSENT=''
  export RV_SMOKE_SHOT=/workspace/artifacts/native-desktop-signup.png
  run_with_keyring
  unset RV_SMOKE_LOGIN RV_SMOKE_INVITATION_FILE
  export RV_SMOKE_SHOT=/workspace/artifacts/native-desktop-signup-resumed.png
  run_with_keyring
  echo 'GTK invitation: existing form creates account, clears secrets, resumes saved account after restart'
fi
if [[ -n "${RV_NATIVE_RECOVERY_FILE:-}" ]]; then
  unset RV_SMOKE_DEVICES RV_SMOKE_EDIT RV_SMOKE_ROOM RV_SMOKE_INVITATION_FILE
  export HOME=/tmp/rv-native-recovery-home XDG_RUNTIME_DIR=/tmp/rv-native-recovery-home/runtime
  mkdir -p "$XDG_RUNTIME_DIR"
  chmod 700 "$XDG_RUNTIME_DIR"
  export RV_SMOKE_LOGIN="$RV_PEER_URL|gtk-recovery|native-recovered-test-password"
  export RV_SMOKE_RECOVERY_FILE="$RV_NATIVE_RECOVERY_FILE"
  export RV_SMOKE_SEND='' RV_SMOKE_EXPECT='' RV_SMOKE_EXPECT_ABSENT=''
  export RV_SMOKE_SHOT=/workspace/artifacts/native-desktop-recovery.png
  run_with_keyring
  unset RV_SMOKE_LOGIN RV_SMOKE_RECOVERY_FILE
  export RV_SMOKE_SHOT=/workspace/artifacts/native-desktop-recovery-resumed.png
  run_with_keyring
  echo 'GTK recovery: existing form resets credentials, clears secrets, resumes keychain after restart'
fi
