//! WinRT toasts and the taskbar badge for an unpackaged app: the app id is
//! registered under HKCU (display name, icon) so Windows accepts its toasts
//! without a Start menu shortcut, and the process claims it so the taskbar
//! groups the window under it.
#![allow(unsafe_code)]

use std::sync::OnceLock;

use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::{IPropertyValue, TypedEventHandler};
use windows::UI::Notifications::{
    BadgeNotification, BadgeUpdateManager, ToastActivatedEventArgs, ToastNotification, ToastNotificationManager,
};
use windows::Win32::System::Registry::{HKEY_CURRENT_USER, REG_SZ, RegSetKeyValueW};
use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
use windows::core::{HSTRING, IInspectable, Interface, PCWSTR};

use crate::{Event, Handler, Toast, decode, tag, toast_xml};

const GROUP: &str = "rooms";

struct State {
    app_id: HSTRING,
    handler: Handler,
}

static STATE: OnceLock<State> = OnceLock::new();

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn set_value(key: &str, name: &str, value: &str) {
    let (key, name, value) = (wide(key), wide(name), wide(value));
    // SAFETY: NUL-terminated UTF-16 buffers that outlive the call; the size is in bytes.
    unsafe {
        let _ = RegSetKeyValueW(
            HKEY_CURRENT_USER,
            PCWSTR(key.as_ptr()),
            PCWSTR(name.as_ptr()),
            REG_SZ.0,
            Some(value.as_ptr().cast()),
            (value.len() * 2) as u32,
        );
    }
}

/// Registers the app id (its display name, and the installed icon when there
/// is one) and routes toast clicks and replies to `handler`.
pub fn init(app_id: &str, display_name: &str, handler: Handler) {
    let key = format!("Software\\Classes\\AppUserModelId\\{app_id}");
    set_value(&key, "DisplayName", display_name);
    if let Ok(exe) = std::env::current_exe()
        && let Some(icon) = exe.parent().and_then(|bin| bin.parent()).map(|root| root.join("rocket-vibe.ico"))
        && icon.exists()
    {
        set_value(&key, "IconUri", &icon.to_string_lossy());
    }
    let id = wide(app_id);
    // SAFETY: a NUL-terminated UTF-16 string that outlives the call.
    let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(PCWSTR(id.as_ptr())) };
    let _ = STATE.set(State { app_id: HSTRING::from(app_id), handler });
}

pub fn available() -> bool {
    STATE.get().is_some()
}

fn reply_text(args: &ToastActivatedEventArgs) -> Option<String> {
    let input = args.UserInput().ok()?;
    let value: IInspectable = input.Lookup(&HSTRING::from("reply")).ok()?;
    let text = value.cast::<IPropertyValue>().ok()?.GetString().ok()?.to_string();
    (!text.trim().is_empty()).then_some(text)
}

fn activated(args: &IInspectable) {
    let Some(state) = STATE.get() else { return };
    let Ok(args) = args.cast::<ToastActivatedEventArgs>() else { return };
    let Some((room, message)) = args.Arguments().ok().and_then(|a| decode(&a.to_string())) else { return };
    let event = match reply_text(&args) {
        Some(text) => Event::Reply { room, message, text },
        None => Event::Open { room, message },
    };
    (state.handler)(event);
}

fn try_show(toast: &Toast) -> windows::core::Result<()> {
    let Some(state) = STATE.get() else { return Ok(()) };
    let doc = XmlDocument::new()?;
    doc.LoadXml(&HSTRING::from(toast_xml(toast)))?;
    let notification = ToastNotification::CreateToastNotification(&doc)?;
    notification.SetTag(&HSTRING::from(tag(toast.room)))?;
    notification.SetGroup(&HSTRING::from(GROUP))?;
    notification.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(|_, args| {
        if let Ok(args) = args.ok() {
            activated(args);
        }
        Ok(())
    }))?;
    ToastNotificationManager::CreateToastNotifierWithId(&state.app_id)?.Show(&notification)
}

pub fn show(toast: &Toast) {
    if let Err(e) = try_show(toast) {
        eprintln!("Toast not shown: {e}");
    }
}

pub fn withdraw(room: &str) {
    let Some(state) = STATE.get() else { return };
    if let Ok(history) = ToastNotificationManager::History() {
        let _ = history.RemoveGroupedTagWithId(&HSTRING::from(tag(room)), &HSTRING::from(GROUP), &state.app_id);
    }
}

fn try_badge(count: i64) -> windows::core::Result<()> {
    let Some(state) = STATE.get() else { return Ok(()) };
    let updater = BadgeUpdateManager::CreateBadgeUpdaterForApplicationWithId(&state.app_id)?;
    if count <= 0 {
        return updater.Clear();
    }
    let doc = XmlDocument::new()?;
    doc.LoadXml(&HSTRING::from(format!("<badge value=\"{}\"/>", count.min(99))))?;
    updater.Update(&BadgeNotification::CreateBadgeNotification(&doc)?)
}

pub fn badge(count: i64) {
    if let Err(e) = try_badge(count) {
        eprintln!("Badge not set: {e}");
    }
}
