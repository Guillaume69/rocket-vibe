//! WinRT toasts and the taskbar badge for an unpackaged app: the app id is
//! registered under HKCU (display name, icon) so Windows accepts its toasts
//! without a Start menu shortcut, and the process claims it so the taskbar
//! groups the window under it.
#![allow(unsafe_code)]

use std::sync::{Arc, OnceLock};

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicIsize, Ordering};
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

use crate::{Event, Handler, Toast, activation, tag, toast_xml};

const GROUP: &str = "rooms";

struct State {
    app_id: HSTRING,
    handler: Arc<dyn Fn(Event) + Send + Sync>,
    /// COM retains the registered factory until the process exits.
    toast_registration: Option<u32>,
}

static STATE: OnceLock<State> = OnceLock::new();

pub(crate) fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

pub(crate) fn set_value(key: &str, name: &str, value: &str) -> windows::core::Result<()> {
    let (key, name, value) = (wide(key), wide(name), wide(value));
    // SAFETY: NUL-terminated UTF-16 buffers that outlive the call; the size is in bytes.
    unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            PCWSTR(key.as_ptr()),
            PCWSTR(name.as_ptr()),
            REG_SZ.0,
            Some(value.as_ptr().cast()),
            (value.len() * 2) as u32,
        )
        .ok()
    }
}

/// Registers the app id (its display name, and the installed icon when there
/// is one) and routes toast clicks and replies to `handler`.
pub fn init(app_id: &str, display_name: &str, handler: Handler) {
    if STATE.get().is_some() {
        return;
    }
    let key = format!("Software\\Classes\\AppUserModelId\\{app_id}");
    let _ = set_value(&key, "DisplayName", display_name);
    if let Ok(exe) = std::env::current_exe()
        && let Some(icon) = exe.parent().and_then(|bin| bin.parent()).map(|root| root.join("rocket-vibe.ico"))
        && icon.exists()
    {
        let _ = set_value(&key, "IconUri", &icon.to_string_lossy());
    }
    let id = wide(app_id);
    // SAFETY: a NUL-terminated UTF-16 string that outlives the call.
    let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(PCWSTR(id.as_ptr())) };
    let handler: Arc<dyn Fn(Event) + Send + Sync> = Arc::from(handler);
    let toast_registration = match crate::windows_toast::register(app_id, handler.clone()) {
        Ok(cookie) => Some(cookie),
        Err(error) => {
            eprintln!("Notification COM activation unavailable: {error}");
            None
        }
    };
    let _ = STATE.set(State { app_id: HSTRING::from(app_id), handler, toast_registration });
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
    let Some(event) = args.Arguments().ok().and_then(|a| activation(&a.to_string(), reply_text(&args))) else {
        return;
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
    // COM handles both warm and cold activations. Keeping a second callback
    // would submit a live inline reply twice for the Rocket.Chat provider.
    if state.toast_registration.is_none() {
        notification.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(|_, args| {
            if let Ok(args) = args.ok() {
                activated(args);
            }
            Ok(())
        }))?;
    }
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

/// Whether Windows holds our toasts back right now: the app's notifications
/// turned off, Focus Assist (Do not disturb), a presentation or a full-screen
/// game. A silent toast's own sound must stay quiet then too.
pub fn quiet() -> bool {
    use windows::UI::Notifications::NotificationSetting;
    use windows::Win32::UI::Shell::{QUNS_ACCEPTS_NOTIFICATIONS, SHQueryUserNotificationState};
    let Some(state) = STATE.get() else { return true };
    let enabled = ToastNotificationManager::CreateToastNotifierWithId(&state.app_id)
        .and_then(|notifier| notifier.Setting())
        .is_ok_and(|setting| setting == NotificationSetting::Enabled);
    // SAFETY: a plain query without arguments.
    let accepting = unsafe { SHQueryUserNotificationState() }.is_ok_and(|s| s == QUNS_ACCEPTS_NOTIFICATIONS);
    !enabled || !accepting || focus_assist()
}

/// Focus Assist has no public API: the shell's own WNF state tells it
/// (WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED: 0 off, 1 priority only,
/// 2 alarms only), read the way other apps do. Unreadable means off.
fn focus_assist() -> bool {
    use std::ffi::c_void;
    use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows::core::s;
    type Query =
        unsafe extern "system" fn(*const u64, *const c_void, *const c_void, *mut u32, *mut c_void, *mut u32) -> i32;
    const QUIET_HOURS: u64 = 0x0d83_063e_a3bf_1c75;
    // SAFETY: ntdll is loaded in every process; NtQueryWnfStateData has had
    // this signature since Windows 8, and writes at most `size` bytes.
    unsafe {
        let Ok(ntdll) = GetModuleHandleW(w!("ntdll.dll")) else { return false };
        let Some(address) = GetProcAddress(ntdll, s!("NtQueryWnfStateData")) else { return false };
        let query = std::mem::transmute::<unsafe extern "system" fn() -> isize, Query>(address);
        let (mut stamp, mut value, mut size) = (0u32, 0u32, 4u32);
        let status =
            query(&QUIET_HOURS, std::ptr::null(), std::ptr::null(), &mut stamp, (&raw mut value).cast(), &mut size);
        status == 0 && value != 0
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
static DOT: AtomicBool = AtomicBool::new(false);

/// The window whose taskbar button carries the badge.
pub fn set_window(hwnd: isize) {
    WINDOW.store(hwnd, Ordering::SeqCst);
    badge(BADGE.load(Ordering::SeqCst), DOT.load(Ordering::SeqCst));
}

/// What Windows sends the window when the keyboard layout changes, for the smoke run.
pub fn input_language_changed() {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayout;
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_INPUTLANGCHANGE};
    let hwnd = WINDOW.load(Ordering::SeqCst);
    if hwnd == 0 {
        return;
    }
    // SAFETY: a window handle of this process and the thread's own layout.
    unsafe {
        let layout = GetKeyboardLayout(0);
        let _ = PostMessageW(
            Some(HWND(hwnd as *mut core::ffi::c_void)),
            WM_INPUTLANGCHANGE,
            WPARAM(0),
            LPARAM(layout.0 as isize),
        );
    }
}

const SIDE: i32 = 32;

/// A red disc of radius `r` centred at `(cx, cy)`, with `text` in white.
pub(crate) struct Disc<'a> {
    pub cx: f32,
    pub cy: f32,
    pub r: f32,
    pub text: &'a str,
}

/// A `side`-pixel icon: `base` (top-down 0xAARRGGBB pixels, or transparent)
/// with `disc` painted over it.
pub(crate) fn icon_with_disc(side: i32, base: Option<&[u32]>, disc: &Disc) -> windows::core::Result<HICON> {
    let text: Vec<u16> = disc.text.encode_utf16().collect();
    // SAFETY: GDI objects created here are released before returning, except the icon handed back.
    unsafe {
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = side;
        info.bmiHeader.biHeight = -side;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let color = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)?;
        let old = SelectObject(dc, color.into());
        let pixels = std::slice::from_raw_parts_mut(bits.cast::<u32>(), (side * side) as usize);
        let inside = |i: usize| {
            let (x, y) = ((i as i32 % side) as f32 + 0.5 - disc.cx, (i as i32 / side) as f32 + 0.5 - disc.cy);
            x * x + y * y <= disc.r * disc.r
        };
        for (i, p) in pixels.iter_mut().enumerate() {
            *p = if inside(i) { 0xFF_E8_3A_5A } else { base.and_then(|b| b.get(i).copied()).unwrap_or(0) };
        }
        if !text.is_empty() {
            let height = if text.len() > 2 { disc.r * 0.8 } else { disc.r * 1.25 };
            let font = CreateFontW(
                -(height.round() as i32),
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
            let mut rect = RECT {
                left: (disc.cx - disc.r).floor() as i32,
                top: (disc.cy - disc.r).floor() as i32,
                right: (disc.cx + disc.r).ceil() as i32,
                bottom: (disc.cy + disc.r).ceil() as i32,
            };
            let mut text = text;
            DrawTextW(dc, &mut text, &mut rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
            SelectObject(dc, old_font);
            let _ = DeleteObject(font.into());
        }
        // GDI leaves alpha at zero where it draws: the disc gets it back.
        for (i, p) in pixels.iter_mut().enumerate() {
            if inside(i) {
                *p |= 0xFF00_0000;
            }
        }
        SelectObject(dc, old);
        let mask = CreateBitmap(side, side, 1, 1, None);
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

/// A red disc with the count in white, or a smaller one alone, as an icon
/// Windows lays over the taskbar button.
fn badge_icon(count: i64) -> windows::core::Result<HICON> {
    let half = SIDE as f32 / 2.0;
    let text = crate::badge_text(count);
    let r = if text.is_empty() { half * 0.6 } else { half };
    icon_with_disc(SIDE, None, &Disc { cx: half, cy: half, r, text: &text })
}

fn try_badge(count: i64, dot: bool) -> windows::core::Result<()> {
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
        if count <= 0 && !dot {
            return taskbar.SetOverlayIcon(hwnd, HICON::default(), PCWSTR::null());
        }
        let icon = badge_icon(count)?;
        let description = HSTRING::from(if count > 0 { count.to_string() } else { "•".to_owned() });
        let set = taskbar.SetOverlayIcon(hwnd, icon, &description);
        let _ = DestroyIcon(icon);
        set
    }
}

/// The count, or a dot, on the taskbar button (Windows keeps no badge for a
/// classic app) and on the notification-area icon.
pub fn badge(count: i64, dot: bool) {
    BADGE.store(count, Ordering::SeqCst);
    DOT.store(dot, Ordering::SeqCst);
    if let Err(e) = try_badge(count, dot) {
        eprintln!("Badge not set: {e}");
    }
    crate::windows_shell::refresh_badge();
}

pub(crate) fn badge_state() -> (i64, bool) {
    (BADGE.load(Ordering::SeqCst), DOT.load(Ordering::SeqCst))
}
