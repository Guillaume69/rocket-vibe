#!/usr/bin/env bash
# After a release build, in an MSYS2 UCRT64 shell: a folder, zipped, that
# runs on a Windows without MSYS2 (the exe, the DLLs it and its plugins
# load, GStreamer plugins for recording and playback, schemas, icons).
#   scripts/package-windows.sh <version>
# The voice sidecar comes prebuilt with MSVC (voice/README.md): $RV_VOICE, else
# dist/voice/rv-voice.exe, put next to the exe; without it the app offers no
# voice, a failure when RV_VOICE_REQUIRED=1 (CI).
set -euo pipefail
cd "$(dirname "$0")/.."
version=$1
voice=${RV_VOICE:-dist/voice/rv-voice.exe}
if [ ! -f "$voice" ]; then
  if [ "${RV_VOICE_REQUIRED:-}" = 1 ]; then
    echo "no voice sidecar at $voice" >&2
    exit 1
  fi
  echo "warning: no voice sidecar at $voice, the package will not offer voice" >&2
  voice=
fi
name="rocket-vibe-desktop-$version-windows-x86_64"
out="dist/$name"
prefix=/ucrt64
rm -rf "$out"
mkdir -p "$out/bin" "$out/lib/gstreamer-1.0" "$out/share/glib-2.0/schemas" "$out/share/icons" "$out/etc"
cp target/release/rocket-vibe-gtk.exe "$out/bin/"
# The call window's WebView2 loader, which the exe loads at start: GNU builds link it as a DLL.
loader=$(find target/release/build -path "*webview2-com-sys-*/out/x64/WebView2Loader.dll" | head -n 1)
cp "$loader" "$out/bin/"
# Static C runtime, no DLL of its own: rv-core looks for it beside the exe.
if [ -n "$voice" ]; then cp "$voice" "$out/bin/rv-voice.exe"; fi

# GStreamer finds its plugins in ../lib/gstreamer-1.0 next to its DLL.
# GTK reads the file through gio's giostreamsrc; Media Foundation decodes H.264 and AAC
# with what Windows already has.
for plugin in coreelements gio audioconvert audioresample autodetect wasapi wasapi2 directsound opus vorbis ogg \
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
