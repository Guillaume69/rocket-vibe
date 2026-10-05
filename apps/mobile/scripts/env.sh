#!/usr/bin/env sh
# Local Android build environment for rocket-vibe.
#
#   source scripts/env.sh
#
# Idempotent: sourcing several times does not stack PATH entries.
# Overridable: RV_JDK_HOME, RV_ANDROID_HOME and RV_ROOT_URL take precedence
# over auto-detection.

# --- JDK detection ----------------------------------------------------------
# We ask javac rather than read the directory name: `jdk1.8.0_171` contains
# "17" without being a JDK 17. The name is no proof of version.
#
# RN 0.86 pins sourceCompatibility = VERSION_17 and Gradle 9.3.1 accepts
# Java 17 to 24. JDK 17 is enough; JDK 21 is not required.
RV_JDK_MIN=17
RV_JDK_MAX=24

# Major version reported by javac, or nothing.
_rv_java_major() {
  [ -x "$1/bin/javac" ] || return 1
  "$1/bin/javac" -version 2>&1 | sed -n 's/^javac \([0-9][0-9]*\).*/\1/p'
}

# First usable JDK under $1, most recent first.
# `sort -V` and not `sort -r`: lexically, jdk-17.0.9 comes before jdk-17.0.19.
# `while read` fed by a heredoc and not by a pipe: a pipe creates a subshell,
# and _rv_found would not come back out of it.
_rv_pick_jdk() {
  [ -d "$1" ] || return 1
  _rv_found=''
  _rv_cands=$(find "$1" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -Vr)
  [ -n "$_rv_cands" ] || return 1
  while IFS= read -r _rv_d; do
    [ -n "$_rv_d" ] || continue
    _rv_major=$(_rv_java_major "$_rv_d") || continue
    case "$_rv_major" in
      '' | *[!0-9]*) continue ;;
    esac
    if [ "$_rv_major" -ge "$RV_JDK_MIN" ] && [ "$_rv_major" -le "$RV_JDK_MAX" ]; then
      _rv_found=$_rv_d
      break
    fi
  done <<EOF
$_rv_cands
EOF
  [ -n "$_rv_found" ] || return 1
  printf '%s' "$_rv_found"
}

if [ -z "$RV_JDK_HOME" ]; then
  RV_JDK_HOME=$(_rv_pick_jdk "$HOME/android-build") \
    || RV_JDK_HOME=$(_rv_pick_jdk /usr/lib/jvm) \
    || RV_JDK_HOME=''
fi

# --- Android SDK detection --------------------------------------------------
if [ -z "$RV_ANDROID_HOME" ]; then
  for _rv_candidate in "$HOME/Android/Sdk" "$HOME/Android/sdk" /opt/android-sdk; do
    if [ -d "$_rv_candidate/platform-tools" ]; then
      RV_ANDROID_HOME="$_rv_candidate"
      break
    fi
  done
fi

# --- Validation -------------------------------------------------------------
# The non-empty test comes first: without it, an empty variable would make
# the test check the absolute path /bin/javac.
if [ -z "$RV_JDK_HOME" ] || [ ! -x "$RV_JDK_HOME/bin/javac" ]; then
  echo "env.sh: no JDK $RV_JDK_MIN-$RV_JDK_MAX found. Set RV_JDK_HOME." >&2
  return 1 2>/dev/null || exit 1
fi
if [ -z "$RV_ANDROID_HOME" ] || [ ! -d "$RV_ANDROID_HOME/platform-tools" ]; then
  echo "env.sh: Android SDK not found. Set RV_ANDROID_HOME." >&2
  return 1 2>/dev/null || exit 1
fi

# --- Export -----------------------------------------------------------------
JAVA_HOME="$RV_JDK_HOME"
ANDROID_HOME="$RV_ANDROID_HOME"
ANDROID_SDK_ROOT="$RV_ANDROID_HOME"
export JAVA_HOME ANDROID_HOME ANDROID_SDK_ROOT

# Adds to PATH only if absent, to stay idempotent.
_rv_prepend_path() {
  case ":$PATH:" in
    *":$1:"*) ;;
    *) PATH="$1:$PATH" ;;
  esac
}
_rv_prepend_path "$JAVA_HOME/bin"
_rv_prepend_path "$ANDROID_HOME/platform-tools"
_rv_prepend_path "$ANDROID_HOME/emulator"
_rv_prepend_path "$ANDROID_HOME/cmdline-tools/latest/bin"
export PATH

# --- Development server -----------------------------------------------------
# The LAN IP, not 10.0.2.2: a physical device must reach the server, and
# ROOT_URL shapes the push payloads and the deep links.
# `adb reverse tcp:3000 tcp:3000` covers the emulator.
#
# Recomputed on every source: the IP changes (DHCP, VPN, wifi to ethernet),
# and a stale ROOT_URL would silently point to the old network.
# RV_ROOT_URL pins the value for whoever needs it.
RV_LAN_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p')
export RV_LAN_IP

if [ -n "$RV_ROOT_URL" ]; then
  ROOT_URL="$RV_ROOT_URL"
  export ROOT_URL
elif [ -n "$RV_LAN_IP" ]; then
  ROOT_URL="http://${RV_LAN_IP}:3000"
  export ROOT_URL
else
  # Better no ROOT_URL at all than a silent "http://:3000".
  unset ROOT_URL
  echo "env.sh: no LAN IP detected (no default route)." >&2
  echo "env.sh: ROOT_URL not set. Use RV_ROOT_URL to force it." >&2
fi

# The release signing key, outside the repo (plugins/with-signature-release.js).
# The file exports RV_KEYSTORE, RV_KEYSTORE_PASSWORD, RV_KEY_ALIAS, RV_KEY_PASSWORD.
if [ -f "$HOME/.config/rocket-vibe/signature.env" ]; then
  . "$HOME/.config/rocket-vibe/signature.env"
fi

if [ -n "$RV_ENV_VERBOSE" ]; then
  echo "JAVA_HOME    = $JAVA_HOME ($(_rv_java_major "$JAVA_HOME"))"
  echo "ANDROID_HOME = $ANDROID_HOME"
  echo "ROOT_URL     = ${ROOT_URL:-<not set>}"
  echo "RV_KEYSTORE  = ${RV_KEYSTORE:-<not set: no release build>}"
fi

# Do not pollute the calling interactive shell.
unset -f _rv_prepend_path _rv_pick_jdk _rv_java_major 2>/dev/null
unset _rv_d _rv_candidate _rv_found _rv_cands _rv_major RV_JDK_MIN RV_JDK_MAX
