//! Started from rocket-vibe.app, the process points GTK, GLib, GStreamer and
//! fontconfig at what the bundle carries in Resources. This happens in the
//! binary, not in a launcher script: under the hardened runtime an app's
//! permissions (the microphone) attach to its signed executable.
#![allow(unsafe_code)]

use std::path::Path;

fn set(key: &str, value: &Path) {
    // SAFETY: only called from bundle_environment, first thing in main,
    // while the process has one thread.
    let _ = unsafe { gtk::glib::setenv(key, value, true) };
}

/// A default the person can override from the environment.
fn default(key: &str, value: &str) {
    // SAFETY: as in set.
    let _ = unsafe { gtk::glib::setenv(key, value, false) };
}

pub fn bundle_environment() {
    let Some(contents) = std::env::current_exe().ok().and_then(|exe| Some(exe.parent()?.parent()?.to_path_buf()))
    else {
        return;
    };
    let res = contents.join("Resources");
    if !res.join("share").is_dir() {
        return;
    }
    let cache = gtk::glib::user_cache_dir().join("rocket-vibe-rs");
    let _ = std::fs::create_dir_all(&cache);
    set("XDG_DATA_DIRS", &res.join("share"));
    set("GSETTINGS_SCHEMA_DIR", &res.join("share/glib-2.0/schemas"));
    set("GDK_PIXBUF_MODULEDIR", &res.join("lib/gdk-pixbuf-2.0/2.10.0/loaders"));
    // SAFETY: as in set.
    unsafe { gtk::glib::unsetenv("GDK_PIXBUF_MODULE_FILE") };
    set("GTK_PATH", &res.join("lib/gtk-4.0"));
    set("GST_PLUGIN_SYSTEM_PATH", &res.join("lib/gstreamer-1.0"));
    set("GST_PLUGIN_SCANNER", &contents.join("MacOS/gst-plugin-scanner"));
    set("GST_REGISTRY", &cache.join("gstreamer-registry.bin"));
    set("FONTCONFIG_PATH", &res.join("etc/fonts"));
    set("FONTCONFIG_FILE", &res.join("etc/fonts/fonts.conf"));
    // Pango's CoreText backend cannot load the app's own fonts; fontconfig can.
    default("PANGOCAIRO_BACKEND", "fc");
    // GTK's OpenGL renderer drew emoji as "?" on macOS and crawled on a Mac
    // without a real GPU. GSK_RENDERER=gl brings it back.
    default("GSK_RENDERER", "cairo");
}
