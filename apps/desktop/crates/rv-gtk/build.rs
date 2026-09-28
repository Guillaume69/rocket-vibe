//! On Windows, the icon goes into the executable: Explorer, the taskbar and
//! the window take it from there.

fn main() {
    println!("cargo:rerun-if-changed=../../data/windows/rocket-vibe.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut resource = winresource::WindowsResource::new();
        let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir");
        resource.set_icon(&format!("{manifest}/../../data/windows/rocket-vibe.ico"));
        resource.compile().expect("Windows resources");
    }
}
