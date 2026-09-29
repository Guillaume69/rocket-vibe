#!/usr/bin/env bash
# The SwiftUI app as a signed .app in a DMG, on macOS:
#   scripts/package.sh <version>
# MACOS_SIGN_IDENTITY picks the Developer ID; without it, an ad-hoc signature.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$1
lib=$(scripts/generate.sh | tail -1)
RV_FFI_LIB_DIR="$PWD/../$lib" swift build -c release --product RocketVibe
bin=$(RV_FFI_LIB_DIR="$PWD/../$lib" swift build -c release --product RocketVibe --show-bin-path)

app="dist/rocket-vibe SwiftUI.app"
contents=$app/Contents
rm -rf dist && mkdir -p "$contents/MacOS" "$contents/Resources"
sed "s/@VERSION@/$version/g" data/Info.plist > "$contents/Info.plist"
cp "$bin/RocketVibe" "$contents/MacOS/"

# Baloo 2 and Nunito, the Android app's faces: Info.plist's ATSApplicationFontsPath registers them.
mkdir -p "$contents/Resources/Fonts"
cp ../crates/rv-gtk/assets/fonts/*.ttf ../crates/rv-gtk/assets/fonts/OFL-*.txt "$contents/Resources/Fonts/"

iconset=dist/rocket-vibe.iconset
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z $size $size ../../mobile/assets/icon.png --out "$iconset/icon_${size}x${size}.png" > /dev/null
  sips -z $((size * 2)) $((size * 2)) ../../mobile/assets/icon.png --out "$iconset/icon_${size}x${size}@2x.png" > /dev/null
done
iconutil -c icns "$iconset" -o "$contents/Resources/rocket-vibe.icns"
rm -rf "$iconset"

leftovers=$(otool -L "$contents/MacOS/RocketVibe" | awk 'NR > 1 && $1 ~ /^\/(opt|usr\/local)\// {print $1}')
if [ -n "$leftovers" ]; then
  echo "linked outside the system: $leftovers" >&2
  exit 1
fi

identity=${MACOS_SIGN_IDENTITY:--}
sign=(codesign --force --sign "$identity" --entitlements data/entitlements.plist)
if [ "$identity" != - ]; then sign+=(--options runtime --timestamp); fi
"${sign[@]}" "$contents/MacOS/RocketVibe"
"${sign[@]}" "$app"
codesign --verify --deep --strict "$app"

name="rocket-vibe-desktop-$version-macos-swiftui-arm64"
mkdir -p dist/dmg
cp -R "$app" dist/dmg/
ln -s /Applications dist/dmg/Applications
hdiutil create -quiet -volname "rocket-vibe SwiftUI" -srcfolder dist/dmg -format UDZO "dist/$name.dmg"
rm -rf dist/dmg
if [ "$identity" != - ]; then codesign --force --sign "$identity" --timestamp "dist/$name.dmg"; fi
echo "dist/$name.dmg"
