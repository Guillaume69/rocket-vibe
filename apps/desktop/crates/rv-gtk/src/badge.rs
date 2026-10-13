//! The unread count on the app's icon, or a dot for plain unread: the Windows
//! taskbar and the macOS dock through rv-native. On Linux, docks that read
//! the Unity launcher protocol (KDE Plasma, Dash to Dock, Plank) show the
//! count; it has no dot. It adds up every signed-in account: the open one's
//! room list, the others' unread state from the background.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use rv_core::rooms::Badge;

thread_local! {
    static SHOWN: Cell<Option<Badge>> = const { Cell::new(None) };
    static OPEN: Cell<Badge> = const { Cell::new(Badge::None) };
    static OPEN_KEY: RefCell<Option<String>> = const { RefCell::new(None) };
    static ACCOUNTS: RefCell<HashMap<String, Badge>> = RefCell::default();
    /// Muted accounts (`rv_core::account_mute`): their count is held back.
    static MUTED: RefCell<std::collections::HashSet<String>> = RefCell::default();
}

/// The muted accounts now, the open one included.
pub fn set_muted(keys: std::collections::HashSet<String>) {
    MUTED.replace(keys);
    show();
}

/// The open account's badge, from its room list.
pub fn set(badge: Badge) {
    OPEN.set(badge);
    show();
}

/// Which account is open: its own badge comes from `set`.
pub fn set_open(key: Option<String>) {
    if OPEN_KEY.replace(key.clone()) != key {
        OPEN.set(Badge::None);
    }
    show();
}

/// An account's badge from the background, or None once it is gone.
pub fn set_account(key: &str, badge: Option<Badge>) {
    ACCOUNTS.with_borrow_mut(|accounts| match badge {
        Some(badge) => accounts.insert(key.to_owned(), badge),
        None => accounts.remove(key),
    });
    show();
}

fn show() {
    let open = OPEN_KEY.with_borrow(Clone::clone);
    let muted = MUTED.with_borrow(Clone::clone);
    let others = ACCOUNTS.with_borrow(|accounts| {
        accounts
            .iter()
            .filter(|(key, _)| open.as_deref() != Some(key.as_str()) && !muted.contains(key.as_str()))
            .map(|(_, b)| *b)
            .collect::<Vec<_>>()
    });
    let own = if open.as_ref().is_some_and(|key| muted.contains(key)) { Badge::None } else { OPEN.get() };
    let badge = Badge::merge(std::iter::once(own).chain(others));
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
