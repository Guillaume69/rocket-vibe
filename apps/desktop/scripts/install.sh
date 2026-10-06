#!/bin/sh
# Installs the latest rocket-vibe desktop release for this user, no root
# needed: the AppImage in ~/.local/bin, a launcher entry and icons, and the
# rocketvibe:// links. Run it again to update; --uninstall removes it all but
# your accounts and messages.
#   curl -fsSL https://raw.githubusercontent.com/Guillaume69/rocket-vibe/master/apps/desktop/scripts/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- --uninstall
set -eu

repo=Guillaume69/rocket-vibe
releases=${ROCKET_VIBE_RELEASES:-https://api.github.com/repos/$repo/releases?per_page=100}
app_id=com.rocketvibe.app
bin_dir=${XDG_BIN_HOME:-$HOME/.local/bin}
data_dir=${XDG_DATA_HOME:-$HOME/.local/share}
appimage=$bin_dir/rocket-vibe.AppImage
desktop=$data_dir/applications/$app_id.desktop
service=$data_dir/dbus-1/services/$app_id.service
icons=$data_dir/icons/hicolor
sizes="32x32 48x48 64x64 128x128 256x256 512x512"

say() { printf '%s\n' "$*"; }
fail() { printf 'rocket-vibe: %s\n' "$*" >&2; exit 1; }

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "curl or wget is needed"
  fi
}

refresh_caches() {
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q "$data_dir/applications" 2>/dev/null || true
  fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t "$icons" 2>/dev/null || true
  fi
}

uninstall() {
  rm -f "$appimage" "$desktop" "$service"
  for size in $sizes; do
    rm -f "$icons/$size/apps/$app_id.png"
  done
  refresh_caches
  say "rocket-vibe is uninstalled."
  say "Your accounts and messages stay in ${XDG_CONFIG_HOME:-$HOME/.config}/rocket-vibe-rs and $data_dir/rocket-vibe-rs; delete them to remove everything."
}

install() {
  [ "$(uname -s)" = Linux ] || fail "this installs the Linux app; see https://github.com/$repo/releases for the others"
  [ "$(uname -m)" = x86_64 ] || fail "only x86_64 is built for now"

  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT INT TERM

  say "Looking for the latest release..."
  fetch "$releases" "$work/releases.json" \
    || fail "cannot reach GitHub"
  url=$(grep -o '"browser_download_url": *"[^"]*/download/desktop-v[0-9]*\.[0-9]*\.[0-9]*/[^"]*-linux-x86_64\.AppImage"' "$work/releases.json" \
    | sed 's/.*"\(http[^"]*\)"$/\1/' \
    | head -n 1)
  [ -n "$url" ] || fail "no desktop release with an AppImage found"
  tag=$(printf '%s\n' "$url" | sed 's|.*/download/\([^/]*\)/.*|\1|')
  version=${tag#desktop-v}

  say "Installing rocket-vibe $version..."
  mkdir -p "$bin_dir" "$data_dir/applications"
  fetch "$url" "$work/rocket-vibe.AppImage" || fail "download failed: $url"
  chmod 755 "$work/rocket-vibe.AppImage"
  mv -f "$work/rocket-vibe.AppImage" "$appimage"

  raw="https://raw.githubusercontent.com/$repo/$tag/apps/desktop/data"
  fetch "$raw/$app_id.desktop" "$work/entry.desktop" || fail "cannot fetch the launcher entry"
  sed -e "s|^Exec=.*|Exec=\"$appimage\" %u|" -e "/^TryExec=/d" "$work/entry.desktop" > "$desktop"
  mkdir -p "$data_dir/dbus-1/services"
  printf '[D-BUS Service]\nName=%s\nExec="%s" --gapplication-service\n' "$app_id" "$appimage" > "$service"
  for size in $sizes; do
    mkdir -p "$icons/$size/apps"
    fetch "$raw/icons/hicolor/$size/apps/$app_id.png" "$icons/$size/apps/$app_id.png" || true
  done
  if command -v xdg-mime >/dev/null 2>&1; then
    xdg-mime default "$app_id.desktop" x-scheme-handler/rocketvibe 2>/dev/null || true
  fi
  refresh_caches

  say "rocket-vibe $version is installed: $appimage"
  say "Start it from your applications menu. It updates itself from then on; running this again works too."
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) say "($bin_dir is not in your PATH: the menu entry works regardless.)" ;;
  esac
}

case "${1:-}" in
  --uninstall) uninstall ;;
  "") install ;;
  *) fail "usage: install.sh [--uninstall]" ;;
esac
