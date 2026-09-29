//! The unread count on the app's icon, or a dot for plain unread: the Windows
//! taskbar and the macOS dock through rv-native. On Linux, docks that read
//! the Unity launcher protocol (KDE Plasma, Dash to Dock, Plank) show the
//! count; it has no dot.

use std::cell::Cell;

use rv_core::rooms::Badge;

thread_local! {
    static SHOWN: Cell<Option<Badge>> = const { Cell::new(None) };
}

pub fn set(badge: Badge) {
    if SHOWN.replace(Some(badge)) == Some(badge) {
        return;
    }
    let (count, dot) = match badge {
        Badge::Count(n) => (n, false),
        Badge::Dot => (0, true),
        Badge::None => (0, false),
    };
    #[cfg(target_os = "linux")]
    {
        let _ = dot;
        unity(count);
    }
    #[cfg(not(target_os = "linux"))]
    rv_native::badge(count, dot);
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
