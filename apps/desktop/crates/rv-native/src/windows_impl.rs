//! WinRT toasts and the taskbar badge for an unpackaged app: the app id is
//! registered under HKCU (display name, icon) so Windows accepts its toasts
//! without a Start menu shortcut, and the process claims it so the taskbar
//! groups the window under it.
#![allow(unsafe_code)]

use std::sync::OnceLock;

use std::sync::atomic::{AtomicI64, AtomicIsize, Ordering};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::{IPropertyValue, TypedEventHandler};

use windows::UI::Notifications::{ToastActivatedEventArgs, ToastNotification, ToastNotificationManager};
use windows::Win32::Foundation::{COLORREF, HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    ANTIALIASED_QUALITY, BITMAPINFO, BITMAPINFOHEADER, CLIP_DEFAULT_PRECIS, CreateBitmap, CreateCompatibleDC,
    CreateDIBSection, CreateFontW, DEFAULT_CHARSET, DIB_RGB_COLORS, DT_CENTER, DT_SINGLELINE, DT_VCENTER, DeleteDC,
    DeleteObject, DrawTextW, GetDC, OUT_DEFAULT_PRECIS, ReleaseDC, SelectObject, SetBkMode, SetTextColor, TRANSPARENT,
};
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx};
use windows::Win32::System::Registry::{HKEY_CURRENT_USER, REG_SZ, RegSetKeyValueW};
use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
use windows::Win32::UI::Shell::{ITaskbarList3, TaskbarList};
use windows::Win32::UI::WindowsAndMessaging::{CreateIconIndirect, DestroyIcon, HICON, ICONINFO};
use windows::core::w;
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

/// Toasts of ours in the Action Center.
pub fn delivered() -> Option<usize> {
    let state = STATE.get()?;
    let history = ToastNotificationManager::History().ok()?.GetHistoryWithId(&state.app_id).ok()?;
    history.Size().ok().map(|n| n as usize)
}

static WINDOW: AtomicIsize = AtomicIsize::new(0);
static BADGE: AtomicI64 = AtomicI64::new(0);

/// The window whose taskbar button carries the badge.
pub fn set_window(hwnd: isize) {
    WINDOW.store(hwnd, Ordering::SeqCst);
    badge(BADGE.load(Ordering::SeqCst));
}

const SIDE: i32 = 32;

/// A red disc with the count in white, as an icon Windows lays over the taskbar button.
fn badge_icon(count: i64) -> windows::core::Result<HICON> {
    let text: Vec<u16> = if count > 99 { "99+".to_owned() } else { count.to_string() }.encode_utf16().collect();
    // SAFETY: GDI objects created here are released before returning, except the icon handed back.
    unsafe {
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = SIDE;
        info.bmiHeader.biHeight = -SIDE;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let color = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)?;
        let old = SelectObject(dc, color.into());
        let pixels = std::slice::from_raw_parts_mut(bits.cast::<u32>(), (SIDE * SIDE) as usize);
        let center = (SIDE as f32 - 1.0) / 2.0;
        let inside = |i: usize| {
            let (x, y) = ((i as i32 % SIDE) as f32 - center, (i as i32 / SIDE) as f32 - center);
            x * x + y * y <= (center + 0.5) * (center + 0.5)
        };
        for (i, p) in pixels.iter_mut().enumerate() {
            *p = if inside(i) { 0xFF_E8_3A_5A } else { 0 };
        }
        let font = CreateFontW(
            if text.len() > 2 { -13 } else { -20 },
            0,
            0,
            0,
            700,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            ANTIALIASED_QUALITY,
            0,
            w!("Segoe UI"),
        );
        let old_font = SelectObject(dc, font.into());
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, COLORREF(0x00FF_FFFF));
        let mut rect = RECT { left: 0, top: 0, right: SIDE, bottom: SIDE };
        let mut text = text;
        DrawTextW(dc, &mut text, &mut rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        // GDI leaves alpha at zero where it draws: the disc gets it back.
        for (i, p) in pixels.iter_mut().enumerate() {
            if inside(i) {
                *p |= 0xFF00_0000;
            }
        }
        SelectObject(dc, old_font);
        let _ = DeleteObject(font.into());
        SelectObject(dc, old);
        let mask = CreateBitmap(SIDE, SIDE, 1, 1, None);
        let icon = CreateIconIndirect(&ICONINFO {
            fIcon: true.into(),
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: mask,
            hbmColor: color,
        });
        let _ = DeleteObject(mask.into());
        let _ = DeleteObject(color.into());
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
        icon
    }
}

fn try_badge(count: i64) -> windows::core::Result<()> {
    let hwnd = WINDOW.load(Ordering::SeqCst);
    if hwnd == 0 {
        return Ok(());
    }
    let hwnd = HWND(hwnd as *mut core::ffi::c_void);
    // SAFETY: COM on this (GTK's) thread; the taskbar object and icon are released here.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let taskbar: ITaskbarList3 = CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)?;
        taskbar.HrInit()?;
        if count <= 0 {
            return taskbar.SetOverlayIcon(hwnd, HICON::default(), PCWSTR::null());
        }
        let icon = badge_icon(count)?;
        let description = HSTRING::from(count.to_string());
        let set = taskbar.SetOverlayIcon(hwnd, icon, &description);
        let _ = DestroyIcon(icon);
        set
    }
}

/// The count on the taskbar button (Windows keeps no badge for a classic app).
pub fn badge(count: i64) {
    BADGE.store(count, Ordering::SeqCst);
    if let Err(e) = try_badge(count) {
        eprintln!("Badge not set: {e}");
    }
}
