fn main() {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    // libwebrtc's screen capture through the desktop portal (PipeWire on
    // Wayland) speaks D-Bus with GIO: webrtc-sys compiles against its headers
    // and leaves linking to the binary. Every Linux desktop has GLib, which the
    // GTK app bundles anyway; X11 and DRM are loaded lazily by webrtc-sys.
    if os == "linux" {
        for lib in ["gio-2.0", "gobject-2.0", "glib-2.0"] {
            println!("cargo:rustc-link-lib=dylib={lib}");
        }
    }
    // libwebrtc's macOS screen capture runs initializers that use its
    // Objective-C categories (NSString+StdString): a static library's
    // categories load only with -ObjC, else the binary aborts before main.
    if os == "macos" {
        println!("cargo:rustc-link-arg-bins=-ObjC");
    }
}
