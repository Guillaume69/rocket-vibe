#!/bin/sh
# Runs inside pkgforge-dev's Arch Linux image (see package-appimage.sh): builds
# the app against Arch's libraries, installs it under /usr, and lets
# quick-sharun gather it with every library it loads, glibc included, into an
# AppImage that needs nothing from the host.
#   scripts/appimage-build.sh <version> <out dir>
set -eu
version=$1
out=$2
cd "$(dirname "$0")/.."

tools=294be3fc770c1418d13d6189e5ee779b81e1b578
base="https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/$tools/useful-tools"
setup="https://raw.githubusercontent.com/pkgforge-dev/anylinux-setup-action/7278cbb7c3692fce7241d427614ef7984192f138/setup.sh"

curl -fsSL --retry 3 "$setup" -o /tmp/anylinux-setup.sh
QUICK_SHARUN="$base/quick-sharun.sh" DEBLOATED_PACKAGES="$base/get-debloated-pkgs.sh" \
  MAKE_AUR_PACKAGE="$base/make-aur-package.sh" sh /tmp/anylinux-setup.sh

pacman -S --needed --noconfirm \
  rust clang pkgconf gtk4 libadwaita \
  gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-libav
get-debloated-pkgs --add-mesa --prefer-nano icu-mini libxml2-mini opus-mini

CARGO_TARGET_DIR=target/appimage cargo build --release --locked -p rocket-vibe-gtk
install -Dm755 target/appimage/release/rocket-vibe-gtk /usr/bin/rocket-vibe-gtk
install -Dm644 data/com.rocketvibe.app.desktop /usr/share/applications/com.rocketvibe.app.desktop
for size in data/icons/hicolor/*; do
  install -Dm644 "$size/apps/com.rocketvibe.app.png" "/usr/share/icons/hicolor/${size##*/}/apps/com.rocketvibe.app.png"
done

export ARCH=x86_64 VERSION="$version" OUTPATH=/tmp/appimage-out CI=1
export DESKTOP=/usr/share/applications/com.rocketvibe.app.desktop
export ICON=/usr/share/icons/hicolor/256x256/apps/com.rocketvibe.app.png
export STARTUPWMCLASS=com.rocketvibe.app GTK_CLASS_FIX=1
export DEPLOY_GSTREAMER=1 DEPLOY_GTK=1
export UPINFO=none
rm -rf AppDir /tmp/appimage-out
quick-sharun /usr/bin/rocket-vibe-gtk /usr/share/icons/Adwaita
bash scripts/fetch-dictionaries.sh AppDir/share/hunspell
bash scripts/fetch-emoji-font.sh AppDir/share/fonts
quick-sharun --make-appimage

mkdir -p "$out"
set -- /tmp/appimage-out/*.AppImage
mv "$1" "$out/rocket-vibe-desktop-$version-linux-x86_64.AppImage"
rm -rf AppDir
echo "$out/rocket-vibe-desktop-$version-linux-x86_64.AppImage"
