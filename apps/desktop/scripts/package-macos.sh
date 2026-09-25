#!/usr/bin/env bash
# After a release build, on macOS with Homebrew's gtk4, libadwaita,
# gstreamer and dylibbundler: rocket-vibe.app, which runs without Homebrew,
# in a DMG. Signed with MACOS_SIGN_IDENTITY (a Developer ID Application
# identity in the keychain, hardened runtime) when set, ad-hoc otherwise.
#   scripts/package-macos.sh <version>
set -euo pipefail
cd "$(dirname "$0")/.."
version=$1
brew=$(brew --prefix)
app=dist/rocket-vibe.app
contents=$app/Contents
res=$contents/Resources
rm -rf "$app" dist/dmg
mkdir -p "$contents/MacOS" "$contents/Frameworks" "$res/lib/gstreamer-1.0" "$res/share/glib-2.0/schemas" "$res/share/icons"

sed "s/@VERSION@/$version/g" data/macos/Info.plist > "$contents/Info.plist"
cp target/release/rocket-vibe-gtk "$contents/MacOS/"
scanner="$brew/libexec/gstreamer-1.0/gst-plugin-scanner"
if [ -f "$scanner" ]; then cp "$scanner" "$contents/MacOS/"; fi

for plugin in coreelements audioconvert audioresample autodetect osxaudio opus ogg playback \
  typefindfunctions audioparsers isomp4 matroska videoconvertscale volume applemedia; do
  file="$brew/lib/gstreamer-1.0/libgst$plugin.dylib"
  if [ -f "$file" ]; then cp "$file" "$res/lib/gstreamer-1.0/"; fi
done
cp -RL "$brew/lib/gdk-pixbuf-2.0" "$res/lib/"
if [ -d "$brew/lib/gtk-4.0" ]; then cp -RL "$brew/lib/gtk-4.0" "$res/lib/"; fi

mkdir -p "$res/etc"
cp -RL "$brew/etc/fonts" "$res/etc/"
cp "$brew"/share/glib-2.0/schemas/*.xml "$res/share/glib-2.0/schemas/"
glib-compile-schemas "$res/share/glib-2.0/schemas"
cp -RL "$brew/share/icons/Adwaita" "$brew/share/icons/hicolor" "$res/share/icons/"

iconset=dist/rocket-vibe.iconset
rm -rf "$iconset" && mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z $size $size ../mobile/assets/icon.png --out "$iconset/icon_${size}x${size}.png" > /dev/null
  sips -z $((size * 2)) $((size * 2)) ../mobile/assets/icon.png --out "$iconset/icon_${size}x${size}@2x.png" > /dev/null
done
iconutil -c icns "$iconset" -o "$res/rocket-vibe.icns"
rm -rf "$iconset"

# Every Mach-O the bundle carries, and the Homebrew libraries they need,
# copied into Frameworks with their paths rewritten.
machos() {
  find "$contents" -type f \( -perm -u+x -o -name '*.dylib' -o -name '*.so' \) -print0 |
    xargs -0 file | awk -F: '/Mach-O/ {print $1}'
}
args=()
while IFS= read -r file; do args+=(-x "$file"); done < <(machos)
if ! dylibbundler -of -b -cd -d "$contents/Frameworks" -p @executable_path/../Frameworks/ -s "$brew/lib" "${args[@]}" \
  > dist/dylibbundler.log 2>&1; then
  cat dist/dylibbundler.log >&2
  exit 1
fi
# Plugins and loaders are opened by path: their own install name still reads
# Homebrew's, which the check below would rightly refuse.
find "$res" -type f \( -name '*.dylib' -o -name '*.so' \) -print0 | while IFS= read -r -d '' file; do
  install_name_tool -id "@loader_path/$(basename "$file")" "$file" 2> /dev/null
done

leftovers=$(machos | while IFS= read -r file; do otool -L "$file" | awk -v f="$file" 'NR > 1 && $1 ~ /^\/(opt|usr\/local)\// {print f ": " $1}'; done)
if [ -n "$leftovers" ]; then
  echo "still pointing into Homebrew:" >&2
  echo "$leftovers" >&2
  exit 1
fi

# Rewriting a library breaks its signature, and Apple Silicon runs nothing
# unsigned. Libraries first, the programs (with their entitlements) last.
identity=${MACOS_SIGN_IDENTITY:--}
sign=(codesign --force --sign "$identity")
if [ "$identity" != - ]; then sign+=(--options runtime --timestamp); fi
machos | grep -v "^$contents/MacOS/" | while IFS= read -r file; do "${sign[@]}" "$file"; done
for program in "$contents/MacOS/gst-plugin-scanner" "$contents/MacOS/rocket-vibe-gtk"; do
  if [ -f "$program" ]; then "${sign[@]}" --entitlements data/macos/entitlements.plist "$program"; fi
done
"${sign[@]}" --entitlements data/macos/entitlements.plist "$app"
codesign --verify --deep --strict "$app"

name="rocket-vibe-desktop-$version-macos-arm64"
mkdir -p dist/dmg
cp -R "$app" dist/dmg/
ln -s /Applications dist/dmg/Applications
rm -f "dist/$name.dmg"
hdiutil create -quiet -volname rocket-vibe -srcfolder dist/dmg -format UDZO "dist/$name.dmg"
rm -rf dist/dmg
if [ "$identity" != - ]; then codesign --force --sign "$identity" --timestamp "dist/$name.dmg"; fi
echo "dist/$name.dmg"
