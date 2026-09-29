//! The unread count on the app's icon: the Windows taskbar and the macOS dock
//! through rv-native; on Linux, docks that read the Unity
//! launcher protocol (KDE Plasma, Dash to Dock, Plank) show it.

use std::cell::Cell;

thread_local! {
    static SHOWN: Cell<Option<i64>> = const { Cell::new(None) };
}

pub fn set(count: i64) {
    if SHOWN.replace(Some(count)) == Some(count) {
        return;
    }
    #[cfg(target_os = "linux")]
    unity(count);
    #[cfg(not(target_os = "linux"))]
    rv_native::badge(count);
}

#[cfg(target_os = "linux")]
fn unity(count: i64) {
    use gtk::prelude::*;
    use gtk::{gio, glib};
    let Ok(bus) = gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>) else { return };
    let properties = glib::VariantDict::new(None);
    properties.insert("count", count);
    properties.insert("count-visible", count > 0);
    let app = format!("application://{}.desktop", crate::APP_ID);
    let _ = bus.emit_signal(
        None,
        "/com/rocketvibe/app/launcherentry",
        "com.canonical.Unity.LauncherEntry",
        "Update",
        Some(&glib::Variant::tuple_from_iter([app.to_variant(), properties.end()])),
    );
}
