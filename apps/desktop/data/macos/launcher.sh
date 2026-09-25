#!/bin/sh
# The bundle's executable: points GTK, GLib and GStreamer at what the bundle
# carries in Resources, then runs the app.
contents="$(cd "$(dirname "$0")/.." && pwd)"
res="$contents/Resources"
cache="$HOME/Library/Caches/rocket-vibe-rs"
mkdir -p "$cache"
export XDG_DATA_DIRS="$res/share"
export GSETTINGS_SCHEMA_DIR="$res/share/glib-2.0/schemas"
export GDK_PIXBUF_MODULEDIR="$res/lib/gdk-pixbuf-2.0/2.10.0/loaders"
unset GDK_PIXBUF_MODULE_FILE
export GTK_PATH="$res/lib/gtk-4.0"
export GST_PLUGIN_SYSTEM_PATH="$res/lib/gstreamer-1.0"
export GST_PLUGIN_SCANNER="$contents/MacOS/gst-plugin-scanner"
export GST_REGISTRY="$cache/gstreamer-registry.bin"
# Pango's CoreText backend cannot load the app's own fonts; fontconfig can.
export PANGOCAIRO_BACKEND="${PANGOCAIRO_BACKEND:-fc}"
export FONTCONFIG_PATH="$res/etc/fonts"
export FONTCONFIG_FILE="$res/etc/fonts/fonts.conf"
# Software rendering: GTK's OpenGL renderer drew emoji as "?" on macOS and
# crawled on a Mac without a real GPU. GSK_RENDERER=gl brings it back.
export GSK_RENDERER="${GSK_RENDERER:-cairo}"
exec "$contents/MacOS/rocket-vibe-gtk" "$@"
