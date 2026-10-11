//! Win32 placement of GTK notification cards. No message content lives here.
#![allow(unsafe_code)]

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, HWND_TOPMOST, IsWindow, SWP_FRAMECHANGED,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SetForegroundWindow, SetWindowLongPtrW, SetWindowPos,
    WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

fn hwnd(handle: isize) -> HWND {
    HWND(handle as *mut std::ffi::c_void)
}

/// Diagnostics used by the real-window launch check.
pub fn notification_foreground() -> isize {
    // SAFETY: a query returning a borrowed window handle.
    unsafe { GetForegroundWindow().0 as isize }
}

pub fn notification_passive(handle: isize) -> bool {
    // SAFETY: a query on the live window supplied by GTK.
    let style = unsafe { GetWindowLongPtrW(hwnd(handle), GWL_EXSTYLE) } as u32;
    style & WS_EX_NOACTIVATE.0 != 0 && style & WS_EX_TOOLWINDOW.0 != 0 && style & WS_EX_APPWINDOW.0 == 0
}

/// Must run before mapping: no taskbar entry, and no automatic activation.
pub fn notification_prepare(handle: isize) -> bool {
    let window = hwnd(handle);
    // SAFETY: GTK hands over its live HWND on the main thread. These calls only
    // change window styles and placement; they retain no pointers.
    unsafe {
        if !IsWindow(Some(window)).as_bool() {
            return false;
        }
        let style = GetWindowLongPtrW(window, GWL_EXSTYLE) as u32;
        SetWindowLongPtrW(
            window,
            GWL_EXSTYLE,
            ((style & !WS_EX_APPWINDOW.0) | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) as isize,
        );
        SetWindowPos(
            window,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED,
        )
        .is_ok()
    }
}

/// Bottom to top on the app window's monitor, inside its usable work area.
pub fn notification_place(handles: &[isize]) -> bool {
    if handles.is_empty() {
        return true;
    }
    // SAFETY: live window handles and stack-owned RECT/MONITORINFO buffers.
    unsafe {
        let monitor = MonitorFromWindow(crate::windows_impl::main_window(), MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &raw mut info).as_bool() {
            return false;
        }
        let mut bottom = info.rcWork.bottom;
        for handle in handles {
            let window = hwnd(*handle);
            let mut rect = RECT::default();
            if GetWindowRect(window, &raw mut rect).is_err() {
                return false;
            }
            let gap = (GetDpiForWindow(window).max(96) * 12 / 96) as i32;
            let width = (rect.right - rect.left).min(info.rcWork.right - info.rcWork.left - 2 * gap);
            let height = rect.bottom - rect.top;
            let top = bottom - gap - height;
            // Never pile cards on top of each other on a small monitor.
            if top < info.rcWork.top + gap || width <= 0 {
                return false;
            }
            if rect.left != info.rcWork.right - gap - width || rect.top != top || rect.right - rect.left != width {
                if SetWindowPos(
                    window,
                    Some(HWND_TOPMOST),
                    info.rcWork.right - gap - width,
                    top,
                    width,
                    height,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                )
                .is_err()
                {
                    return false;
                }
            }
            bottom = top;
        }
        true
    }
}

/// Only an explicit click on Reply may activate a card and its text field.
pub fn notification_focus(handle: isize) {
    let window = hwnd(handle);
    // SAFETY: same live GTK window; activation follows an explicit user gesture.
    unsafe {
        let style = GetWindowLongPtrW(window, GWL_EXSTYLE) as u32;
        SetWindowLongPtrW(window, GWL_EXSTYLE, (style & !WS_EX_NOACTIVATE.0) as isize);
        let _ = SetForegroundWindow(window);
    }
}
