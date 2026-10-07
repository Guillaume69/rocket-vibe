#!/usr/bin/env bash
# The SwiftUI app as a signed .app in a DMG, on macOS:
#   scripts/package.sh <version>
# MACOS_SIGN_IDENTITY picks the Developer ID; without it, an ad-hoc signature.
# The voice sidecar comes prebuilt (../voice/README.md): $RV_VOICE, else
# ../dist/voice/rv-voice, put in Contents/MacOS where rv-core looks for it;
# without it the app offers no voice, a failure when RV_VOICE_REQUIRED=1.
# The voice sounds are rendered by node (scripts/sounds) and encoded to AAC.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$1
voice=${RV_VOICE:-../dist/voice/rv-voice}
if [ ! -f "$voice" ]; then
  if [ "${RV_VOICE_REQUIRED:-0}" = 1 ]; then
    echo "no voice sidecar at $voice" >&2
    exit 1
  fi
  echo "warning: no voice sidecar at $voice, the bundle will not offer voice" >&2
  voice=
fi
lib=$(scripts/generate.sh | tail -1)
RV_FFI_LIB_DIR="$PWD/../$lib" swift build -c release --product RocketVibe
bin=$(RV_FFI_LIB_DIR="$PWD/../$lib" swift build -c release --product RocketVibe --show-bin-path)

app="dist/rocket-vibe SwiftUI.app"
contents=$app/Contents
rm -rf dist && mkdir -p "$contents/MacOS" "$contents/Resources"
sed "s/@VERSION@/$version/g" data/Info.plist > "$contents/Info.plist"
cp "$bin/RocketVibe" "$contents/MacOS/"
if [ -n "$voice" ]; then install -m 755 "$voice" "$contents/MacOS/rv-voice"; fi

# The voice cues and ringtones, AVAudioPlayer reading no Ogg: AAC from the WAV masters.
masters=$(mktemp -d)
node ../../../scripts/sounds/generate.mjs --out "$masters" > /dev/null
mkdir -p "$contents/Resources/sounds"
for wav in "$masters"/*.wav; do
  afconvert -f m4af -d aac -b 128000 "$wav" "$contents/Resources/sounds/$(basename "$wav" .wav).m4a"
done
rm -rf "$masters"

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

leftovers=$(otool -L "$contents"/MacOS/* | awk 'NR > 1 && $1 ~ /^\/(opt|usr\/local)\// {print $1}')
if [ -n "$leftovers" ]; then
  echo "linked outside the system: $leftovers" >&2
  exit 1
fi

identity=${MACOS_SIGN_IDENTITY:--}
sign=(codesign --force --sign "$identity" --entitlements data/entitlements.plist)
if [ "$identity" != - ]; then sign+=(--options runtime --timestamp); fi
# rv-voice opens the microphone and the camera: the app's entitlements.
if [ -n "$voice" ]; then "${sign[@]}" "$contents/MacOS/rv-voice"; fi
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
