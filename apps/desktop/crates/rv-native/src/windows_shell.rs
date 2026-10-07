//! The app's hidden window on Windows: the notification-area icon and its
//! menu, the one instance a second launch hands its link to, and the login
//! entry in the `Run` key. The window lives on GTK's thread, whose message
//! loop dispatches to it.
#![allow(unsafe_code)]

use std::cell::RefCell;
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};

use windows::Win32::Foundation::{
    ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, GetLastError, HWND, LPARAM, LRESULT, POINT, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDIBits,
};
use windows::Win32::System::DataExchange::COPYDATASTRUCT;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Registry::{
    HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ, RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW,
};
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::Shell::{
    NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFY_ICON_MESSAGE, NOTIFYICONDATAW,
    Shell_NotifyIconW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyMenu,
    FindWindowW, GetCursorPos, GetIconInfo, GetSystemMetrics, GetWindowThreadProcessId, HICON, ICONINFO,
    IDI_APPLICATION, IMAGE_ICON, LR_DEFAULTCOLOR, LR_LOADFROMFILE, LoadIconW, LoadImageW, MF_STRING, PostMessageW,
    RegisterClassW, RegisterWindowMessageW, SM_CXSMICON, SMTO_ABORTIFHUNG, SendMessageTimeoutW, SetForegroundWindow,
    SetMenuDefaultItem, TPM_BOTTOMALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON, TrackPopupMenu, WINDOW_EX_STYLE, WM_APP,
    WM_COPYDATA, WM_LBUTTONUP, WM_NULL, WM_RBUTTONUP, WNDCLASSW, WS_POPUP,
};
use windows::core::{PCWSTR, w};

use crate::windows_impl::{Disc, icon_with_disc, wide};
use crate::{AppEvent, AppHandler, TrayLabels};

/// `RV_INSTANCE=<name>` (letters, digits, `-`, `_`): an instance apart from
/// the usual one, with its own lock and window, so several run side by side
/// (two accounts tested on one machine). Its data folders come from `XDG_*`.
fn instance() -> String {
    std::env::var("RV_INSTANCE")
        .ok()
        .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .map(|n| format!("-{n}"))
        .unwrap_or_default()
}

/// The hidden window's class, which later launches look for.
fn class() -> Vec<u16> {
    wide(&format!("RocketVibeHidden{}", instance()))
}
const WM_TRAY: u32 = WM_APP + 1;
const FORWARD: usize = 0x5256;
const OPEN: usize = 1;
const QUIT: usize = 2;
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE: &str = "rocket-vibe";

static WINDOW: AtomicIsize = AtomicIsize::new(0);
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);

thread_local! {
    static HANDLER: RefCell<Option<AppHandler>> = RefCell::default();
    /// The menu's labels while the icon is in the notification area.
    static MENU: RefCell<Option<(String, String)>> = RefCell::default();
}

fn emit(event: AppEvent) {
    let handler = HANDLER.with_borrow(Clone::clone);
    if let Some(handler) = handler {
        handler(event);
    }
}

/// Where tray clicks and second launches are reported.
pub fn app_events(handler: AppHandler) {
    HANDLER.with_borrow_mut(|h| *h = Some(handler));
}

fn hidden_window() -> Option<HWND> {
    let existing = WINDOW.load(Ordering::SeqCst);
    if existing != 0 {
        return Some(HWND(existing as *mut core::ffi::c_void));
    }
    let name = class();
    // SAFETY: a window class and a never-shown window, registered and created once on this thread;
    // `name` outlives both calls.
    unsafe {
        let instance = GetModuleHandleW(None).ok()?;
        let class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance.into(),
            lpszClassName: PCWSTR(name.as_ptr()),
            ..Default::default()
        };
        RegisterClassW(&class);
        TASKBAR_CREATED.store(RegisterWindowMessageW(w!("TaskbarCreated")), Ordering::SeqCst);
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            PCWSTR(name.as_ptr()),
            w!("rocket-vibe"),
            WS_POPUP,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance.into()),
            None,
        )
        .ok()?;
        WINDOW.store(hwnd.0 as isize, Ordering::SeqCst);
        Some(hwnd)
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WM_TRAY => {
            match lparam.0 as u32 {
                WM_LBUTTONUP => emit(AppEvent::Show),
                WM_RBUTTONUP => {
                    // SAFETY: our own window, on its thread.
                    if let Some(event) = unsafe { menu(hwnd) } {
                        emit(event);
                    }
                }
                _ => {}
            }
            LRESULT(0)
        }
        WM_COPYDATA => {
            // SAFETY: WM_COPYDATA's lparam points to the sender's COPYDATASTRUCT for the call's duration.
            let data = unsafe { &*(lparam.0 as *const COPYDATASTRUCT) };
            if data.dwData == FORWARD && !data.lpData.is_null() {
                // SAFETY: cbData bytes of UTF-16 at lpData, as the sender wrote them.
                let units = unsafe { std::slice::from_raw_parts(data.lpData.cast::<u16>(), data.cbData as usize / 2) };
                if let Some(event) = crate::forwarded(&String::from_utf16_lossy(units)) {
                    emit(event);
                }
            }
            LRESULT(1)
        }
        m if m != 0 && m == TASKBAR_CREATED.load(Ordering::SeqCst) => {
            if MENU.with_borrow(Option::is_some) {
                refresh(NIM_ADD);
            }
            LRESULT(0)
        }
        // SAFETY: the default handling of a message for our own window.
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

unsafe fn menu(hwnd: HWND) -> Option<AppEvent> {
    let (open, quit) = MENU.with_borrow(Clone::clone)?;
    let (open, quit) = (wide(&open), wide(&quit));
    // SAFETY: a popup menu owned here, shown modally for our window, then destroyed.
    unsafe {
        let menu = CreatePopupMenu().ok()?;
        let built = AppendMenuW(menu, MF_STRING, OPEN, PCWSTR(open.as_ptr()))
            .and_then(|_| AppendMenuW(menu, MF_STRING, QUIT, PCWSTR(quit.as_ptr())));
        if built.is_err() {
            let _ = DestroyMenu(menu);
            return None;
        }
        let _ = SetMenuDefaultItem(menu, OPEN as u32, 0);
        let mut at = POINT::default();
        let _ = GetCursorPos(&mut at);
        let _ = SetForegroundWindow(hwnd);
        let chosen =
            TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, at.x, at.y, None, hwnd, None);
        let _ = PostMessageW(Some(hwnd), WM_NULL, WPARAM(0), LPARAM(0));
        let _ = DestroyMenu(menu);
        match chosen.0 as usize {
            OPEN => Some(AppEvent::Show),
            QUIT => Some(AppEvent::Quit),
            _ => None,
        }
    }
}

/// The app's own icon at `side` pixels, as top-down 0xAARRGGBB pixels.
unsafe fn app_icon_pixels(side: i32) -> Option<Vec<u32>> {
    // SAFETY: icons and bitmaps loaded here are released before returning.
    unsafe {
        let module = GetModuleHandleW(None).ok()?;
        let embedded = LoadImageW(
            Some(module.into()),
            PCWSTR(std::ptr::without_provenance(1)),
            IMAGE_ICON,
            side,
            side,
            LR_DEFAULTCOLOR,
        );
        let file = || {
            let exe = std::env::current_exe().ok()?;
            let path = wide(&exe.parent()?.parent()?.join("rocket-vibe.ico").to_string_lossy());
            LoadImageW(None, PCWSTR(path.as_ptr()), IMAGE_ICON, side, side, LR_LOADFROMFILE).ok()
        };
        let (icon, owned) = match embedded.ok().or_else(file) {
            Some(handle) => (HICON(handle.0), true),
            None => (LoadIconW(None, IDI_APPLICATION).ok()?, false),
        };
        let mut info = ICONINFO::default();
        let read = GetIconInfo(icon, &mut info);
        if owned {
            let _ = DestroyIcon(icon);
        }
        read.ok()?;
        let dc = CreateCompatibleDC(None);
        let mut header = BITMAPINFO::default();
        header.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        header.bmiHeader.biWidth = side;
        header.bmiHeader.biHeight = -side;
        header.bmiHeader.biPlanes = 1;
        header.bmiHeader.biBitCount = 32;
        let mut pixels = vec![0u32; (side * side) as usize];
        let lines =
            GetDIBits(dc, info.hbmColor, 0, side as u32, Some(pixels.as_mut_ptr().cast()), &mut header, DIB_RGB_COLORS);
        let _ = DeleteDC(dc);
        let _ = DeleteObject(info.hbmColor.into());
        let _ = DeleteObject(info.hbmMask.into());
        if lines == 0 {
            return None;
        }
        if pixels.iter().all(|p| p >> 24 == 0) {
            for p in &mut pixels {
                *p |= 0xFF00_0000;
            }
        }
        Some(pixels)
    }
}

/// The app's icon with the badge in its corner: the count, or a dot.
fn tray_icon(count: i64, dot: bool) -> Option<HICON> {
    // SAFETY: a system metric; the pixels are read from our own icon.
    let (side, base) = unsafe {
        let side = GetSystemMetrics(SM_CXSMICON).max(16);
        (side, app_icon_pixels(side))
    };
    let side_f = side as f32;
    let text = crate::badge_text(count);
    let disc = match (text.is_empty(), dot) {
        (false, _) => {
            let r = side_f * 0.36;
            Disc { cx: side_f - r, cy: side_f - r, r, text: &text }
        }
        (true, true) => {
            let r = side_f * 0.22;
            Disc { cx: side_f - r - 1.0, cy: side_f - r - 1.0, r, text: "" }
        }
        (true, false) => Disc { cx: -side_f, cy: -side_f, r: 0.0, text: "" },
    };
    icon_with_disc(side, base.as_deref(), &disc).ok()
}

fn refresh(message: NOTIFY_ICON_MESSAGE) {
    let Some(hwnd) = hidden_window() else { return };
    let (count, dot) = crate::windows_impl::badge_state();
    let icon = tray_icon(count, dot);
    let mut data = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: hwnd,
        uID: 1,
        uFlags: NIF_ICON | NIF_MESSAGE | NIF_TIP,
        uCallbackMessage: WM_TRAY,
        hIcon: icon.unwrap_or_default(),
        ..Default::default()
    };
    let tip = match crate::badge_text(count) {
        text if text.is_empty() => "rocket-vibe".to_owned(),
        text => format!("rocket-vibe ({text})"),
    };
    for (slot, unit) in data.szTip.iter_mut().zip(tip.encode_utf16().take(127)) {
        *slot = unit;
    }
    // SAFETY: a filled NOTIFYICONDATAW for our window; the shell copies the icon.
    let done = unsafe { Shell_NotifyIconW(message, &data).as_bool() };
    if message == NIM_ADD {
        println!("native: tray icon {}", if done { "added" } else { "not added" });
    }
    if let Some(icon) = icon {
        // SAFETY: the icon made above, no longer needed once the shell has its copy.
        let _ = unsafe { DestroyIcon(icon) };
    }
}

/// Redraws the icon's badge, when the icon is there.
pub(crate) fn refresh_badge() {
    if MENU.with_borrow(Option::is_some) {
        refresh(NIM_MODIFY);
    }
}

/// Puts the icon in the notification area with its menu, or takes it away.
pub fn tray(labels: Option<TrayLabels>) {
    match labels {
        Some(labels) => {
            let shown = MENU.with_borrow_mut(|m| m.replace((labels.open.to_owned(), labels.quit.to_owned())).is_some());
            if !shown {
                refresh(NIM_ADD);
            }
        }
        None => {
            if MENU.take().is_some()
                && let Some(hwnd) = hidden_window()
            {
                let data = NOTIFYICONDATAW {
                    cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
                    hWnd: hwnd,
                    uID: 1,
                    ..Default::default()
                };
                // SAFETY: removes the icon this window added.
                let _ = unsafe { Shell_NotifyIconW(NIM_DELETE, &data) };
            }
        }
    }
}

/// True for the first launch, which then receives the later ones; a later
/// launch hands its arguments over and gets false.
pub fn claim_instance(args: &[String]) -> bool {
    let (lock, name) = (wide(&format!("Local\\com.rocketvibe.app{}", instance())), class());
    // SAFETY: a named mutex kept open for the life of the process; a window lookup and a synchronous
    // message; `lock` and `name` outlive the calls.
    unsafe {
        let mutex = CreateMutexW(None, false, PCWSTR(lock.as_ptr()));
        if !(mutex.is_ok() && GetLastError() == ERROR_ALREADY_EXISTS) {
            let _ = hidden_window();
            return true;
        }
        let payload: Vec<u16> = args.join("\n").encode_utf16().collect();
        for _ in 0..30 {
            if let Ok(hwnd) = FindWindowW(PCWSTR(name.as_ptr()), PCWSTR::null())
                && !hwnd.is_invalid()
            {
                let mut pid = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                let _ = AllowSetForegroundWindow(pid);
                let data = COPYDATASTRUCT {
                    dwData: FORWARD,
                    cbData: (payload.len() * 2) as u32,
                    lpData: payload.as_ptr() as *mut core::ffi::c_void,
                };
                SendMessageTimeoutW(
                    hwnd,
                    WM_COPYDATA,
                    WPARAM(0),
                    LPARAM(&data as *const COPYDATASTRUCT as isize),
                    SMTO_ABORTIFHUNG,
                    5000,
                    None,
                );
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        true
    }
}

pub fn autostart_supported() -> bool {
    true
}

pub fn autostart() -> bool {
    let (key, name) = (wide(RUN_KEY), wide(RUN_VALUE));
    // SAFETY: NUL-terminated names; only the value's presence is read.
    unsafe {
        RegGetValueW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()), PCWSTR(name.as_ptr()), RRF_RT_REG_SZ, None, None, None)
            == ERROR_SUCCESS
    }
}

pub fn set_autostart(on: bool) -> Result<(), String> {
    let (key, name) = (wide(RUN_KEY), wide(RUN_VALUE));
    // SAFETY: NUL-terminated UTF-16 buffers that outlive the calls; the size is in bytes.
    let status = unsafe {
        if on {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let command = wide(&crate::run_command(&exe.to_string_lossy()));
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                PCWSTR(name.as_ptr()),
                REG_SZ.0,
                Some(command.as_ptr().cast()),
                (command.len() * 2) as u32,
            )
        } else {
            match RegDeleteKeyValueW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()), PCWSTR(name.as_ptr())) {
                ERROR_FILE_NOT_FOUND => ERROR_SUCCESS,
                status => status,
            }
        }
    };
    if status == ERROR_SUCCESS { Ok(()) } else { Err(format!("registry error {}", status.0)) }
}
