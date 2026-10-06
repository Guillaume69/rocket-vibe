#!/bin/sh
# Runs inside pkgforge-dev's Arch Linux image (see package-appimage.sh): builds
# the app against Arch's libraries, installs it under /usr, and lets
# quick-sharun gather it with every library it loads, glibc included, into an
# AppImage that needs nothing from the host.
#   scripts/appimage-build.sh <version> <out dir>
# The voice sidecar comes prebuilt (voice/scripts/build-linux.sh, glibc 2.35):
# $RV_VOICE, else dist/voice/rv-voice; without it the AppImage offers no voice,
# a failure when RV_VOICE_REQUIRED=1 (CI).
set -eu
version=$1
out=$2
cd "$(dirname "$0")/.."
voice=${RV_VOICE:-dist/voice/rv-voice}
if [ ! -f "$voice" ]; then
  if [ "${RV_VOICE_REQUIRED:-}" = 1 ]; then
    echo "no voice sidecar at $voice" >&2
    exit 1
  fi
  echo "warning: no voice sidecar at $voice, the AppImage will not offer voice" >&2
  voice=
fi

tools=294be3fc770c1418d13d6189e5ee779b81e1b578
base="https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/$tools/useful-tools"
setup="https://raw.githubusercontent.com/pkgforge-dev/anylinux-setup-action/7278cbb7c3692fce7241d427614ef7984192f138/setup.sh"

curl -fsSL --retry 3 "$setup" -o /tmp/anylinux-setup.sh
QUICK_SHARUN="$base/quick-sharun.sh" DEBLOATED_PACKAGES="$base/get-debloated-pkgs.sh" \
  MAKE_AUR_PACKAGE="$base/make-aur-package.sh" sh /tmp/anylinux-setup.sh

pacman -S --needed --noconfirm \
  rust clang pkgconf gtk4 libadwaita webkitgtk-6.0 \
  gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-libav
get-debloated-pkgs --add-mesa --prefer-nano icu-mini libxml2-mini opus-mini

CARGO_TARGET_DIR=target/appimage cargo build --release --locked -p rocket-vibe-gtk
install -Dm755 target/appimage/release/rocket-vibe-gtk /usr/bin/rocket-vibe-gtk
# Wrapped by sharun like the app, so it runs on the bundled glibc and finds the
# bundled PulseAudio that libwebrtc opens: AppDir/bin/rv-voice, which the app
# finds under $SHARUN_DIR (rv-core/src/voice.rs).
sidecar=
if [ -n "$voice" ]; then
  install -Dm755 "$voice" /usr/bin/rv-voice
  sidecar=/usr/bin/rv-voice
fi
install -Dm644 data/com.rocketvibe.app.desktop /usr/share/applications/com.rocketvibe.app.desktop
for size in data/icons/hicolor/*; do
  install -Dm644 "$size/apps/com.rocketvibe.app.png" "/usr/share/icons/hicolor/${size##*/}/apps/com.rocketvibe.app.png"
done

export ARCH=x86_64 VERSION="$version" OUTPATH=/tmp/appimage-out CI=1
export DESKTOP=/usr/share/applications/com.rocketvibe.app.desktop
export ICON=/usr/share/icons/hicolor/256x256/apps/com.rocketvibe.app.png
export STARTUPWMCLASS=com.rocketvibe.app GTK_CLASS_FIX=1
export DEPLOY_GSTREAMER=1 DEPLOY_GTK=1 DEPLOY_PULSE=1
export UPINFO=none
rm -rf AppDir /tmp/appimage-out
# shellcheck disable=SC2086 # $sidecar is empty or one path.
quick-sharun /usr/bin/rocket-vibe-gtk $sidecar /usr/share/icons/Adwaita
bash scripts/fetch-dictionaries.sh AppDir/share/hunspell
bash scripts/fetch-emoji-font.sh AppDir/share/fonts
quick-sharun --make-appimage

mkdir -p "$out"
set -- /tmp/appimage-out/*.AppImage
mv "$1" "$out/rocket-vibe-desktop-$version-linux-x86_64.AppImage"
rm -rf AppDir
echo "$out/rocket-vibe-desktop-$version-linux-x86_64.AppImage"
