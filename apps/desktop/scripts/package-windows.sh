#!/usr/bin/env bash
# After a release build, in an MSYS2 UCRT64 shell: a folder, zipped, that
# runs on a Windows without MSYS2 (the exe, the DLLs it and its plugins
# load, GStreamer plugins for recording and playback, schemas, icons).
#   scripts/package-windows.sh <version>
set -euo pipefail
cd "$(dirname "$0")/.."
version=$1
name="rocket-vibe-desktop-$version-windows-x86_64"
out="dist/$name"
prefix=/ucrt64
rm -rf "$out"
mkdir -p "$out/bin" "$out/lib/gstreamer-1.0" "$out/share/glib-2.0/schemas" "$out/share/icons" "$out/etc"
cp target/release/rocket-vibe-gtk.exe "$out/bin/"

# GStreamer finds its plugins in ../lib/gstreamer-1.0 next to its DLL.
# Media Foundation decodes H.264 and AAC with what Windows already has.
for plugin in coreelements audioconvert audioresample autodetect wasapi wasapi2 directsound opus vorbis ogg \
  playback typefindfunctions audioparsers isomp4 matroska videoconvertscale volume mediafoundation; do
  cp "$prefix/lib/gstreamer-1.0/libgst$plugin.dll" "$out/lib/gstreamer-1.0/"
done
cp -r "$prefix/lib/gdk-pixbuf-2.0" "$out/lib/"

# Every DLL from the MSYS2 prefix that the exe, the plugins or the loaders pull in.
ldd "$out/bin/rocket-vibe-gtk.exe" "$out"/lib/gstreamer-1.0/*.dll "$out"/lib/gdk-pixbuf-2.0/2.10.0/loaders/*.dll \
  | awk '$3 ~ /^\/ucrt64\// {print $3}' | sort -u | xargs -r cp -t "$out/bin/"

# fontconfig, which the app uses for text on Windows, finds its configuration in ../etc/fonts.
cp -r "$prefix/etc/fonts" "$out/etc/"
cp "$prefix"/share/glib-2.0/schemas/*.xml "$out/share/glib-2.0/schemas/"
glib-compile-schemas "$out/share/glib-2.0/schemas"
cp -r "$prefix/share/icons/Adwaita" "$prefix/share/icons/hicolor" "$out/share/icons/"
scripts/fetch-dictionaries.sh "$out/share/hunspell"
scripts/fetch-emoji-font.sh "$out/share/fonts"
cp README.md "$out/"

(cd dist && rm -f "$name.zip" && zip -qr "$name.zip" "$name")
echo "dist/$name.zip"
