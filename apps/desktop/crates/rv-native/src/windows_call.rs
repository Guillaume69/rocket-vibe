//! The call window on Windows: the meeting page in WebView2, the Edge
//! engine Windows 10 and 11 carry, in a window of its own. WebView2 answers
//! on this thread through window messages, which GTK's loop dispatches.

#![allow(unsafe_code)]

use std::cell::RefCell;
use std::collections::HashMap;

use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
    COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY, CreateCoreWebView2EnvironmentWithOptions,
    GetAvailableCoreWebView2BrowserVersionString, ICoreWebView2Controller, ICoreWebView2Environment,
};
use webview2_com::{
    CoTaskMemPWSTR, CreateCoreWebView2ControllerCompletedHandler, CreateCoreWebView2EnvironmentCompletedHandler,
    NavigationCompletedEventHandler, NavigationStartingEventHandler, NewWindowRequestedEventHandler,
    PermissionRequestedEventHandler, WindowCloseRequestedEventHandler, take_pwstr,
};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT, CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, IDC_ARROW,
    LoadCursorW, LoadIconW, PostMessageW, RegisterClassW, SW_SHOWNORMAL, WM_APP, WM_CLOSE, WM_DESTROY, WM_SIZE,
    WNDCLASSW, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};
use windows::core::{PCWSTR, PWSTR, w};

use crate::call_event;

type Allowed = fn(&str, &str) -> bool;

/// Posted to a call window once its engine is ready: the page is made from
/// the window's own message, not from inside the engine's creation, which
/// can answer before it returns and hang when called back into.
const WM_ENGINE_READY: u32 = WM_APP + 1;

struct Pending {
    environment: ICoreWebView2Environment,
    url: String,
    allowed: Allowed,
}

thread_local! {
    static CONTROLLERS: RefCell<HashMap<isize, ICoreWebView2Controller>> = RefCell::default();
    static PENDING: RefCell<HashMap<isize, Pending>> = RefCell::default();
}

fn make_page(hwnd: HWND) {
    let Some(pending) = PENDING.with_borrow_mut(|p| p.remove(&(hwnd.0 as isize))) else { return };
    let Pending { environment, url, allowed } = pending;
    let controller_ready = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(move |error, controller| {
        error?;
        let Some(controller) = controller else { return Ok(()) };
        // SAFETY: the controller and its page answer on this thread.
        unsafe { attach(hwnd, &controller, &url, allowed) }
    }));
    // SAFETY: the window outlives the request, which answers on this thread.
    if let Err(e) = unsafe { environment.CreateCoreWebView2Controller(hwnd, &controller_ready) } {
        call_event("page", &format!("not made: {e}"));
    }
}

pub(crate) fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

pub(crate) fn open_in_browser(url: &str) {
    let url = wide(url);
    // SAFETY: NUL-terminated wide strings that outlive the call.
    unsafe {
        ShellExecuteW(None, w!("open"), PCWSTR(url.as_ptr()), None, None, SW_SHOWNORMAL);
    }
}

fn fit(hwnd: HWND) {
    let mut rect = RECT::default();
    // SAFETY: a window of this thread.
    let _ = unsafe { GetClientRect(hwnd, &mut rect) };
    CONTROLLERS.with_borrow(|c| {
        if let Some(controller) = c.get(&(hwnd.0 as isize)) {
            // SAFETY: the controller lives on this thread, with its window.
            let _ = unsafe { controller.SetBounds(rect) };
        }
    });
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WM_SIZE => {
            fit(hwnd);
            LRESULT(0)
        }
        WM_ENGINE_READY => {
            make_page(hwnd);
            LRESULT(0)
        }
        WM_CLOSE => {
            PENDING.with_borrow_mut(|p| p.remove(&(hwnd.0 as isize)));
            if let Some(controller) = CONTROLLERS.with_borrow_mut(|c| c.remove(&(hwnd.0 as isize))) {
                // SAFETY: closing the engine before its window goes.
                let _ = unsafe { controller.Close() };
            }
            // SAFETY: our own window.
            let _ = unsafe { DestroyWindow(hwnd) };
            LRESULT(0)
        }
        WM_DESTROY => LRESULT(0),
        // SAFETY: the default handling of our own window's messages.
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

fn register_class() -> Result<PCWSTR, String> {
    thread_local!(static REGISTERED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });
    let name = w!("RocketVibeCall");
    if REGISTERED.get() {
        return Ok(name);
    }
    // SAFETY: a class whose procedure and strings are static.
    unsafe {
        let instance = GetModuleHandleW(None).map_err(|e| e.to_string())?;
        let class = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(window_proc),
            hInstance: instance.into(),
            hIcon: LoadIconW(Some(instance.into()), PCWSTR(1 as _)).unwrap_or_default(),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            lpszClassName: name,
            ..Default::default()
        };
        if RegisterClassW(&class) == 0 {
            return Err("the call window class could not be registered".to_owned());
        }
    }
    REGISTERED.set(true);
    Ok(name)
}

fn user_data() -> Vec<u16> {
    let base = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
    wide(&base.join("rocket-vibe-rs").join("webview2").to_string_lossy())
}

fn permission_kind(kind: COREWEBVIEW2_PERMISSION_KIND) -> Option<&'static str> {
    match kind {
        COREWEBVIEW2_PERMISSION_KIND_CAMERA => Some("camera"),
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => Some("microphone"),
        _ => None,
    }
}

/// The call at `url` in a window titled `title`; `allowed(address, url)` says
/// where it may go. Err when the WebView2 runtime is missing.
pub fn call_window(url: &str, title: &str, allowed: Allowed) -> Result<(), String> {
    let mut version = PWSTR::null();
    // SAFETY: WebView2's own lookup of an installed runtime.
    unsafe { GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut version) }
        .map_err(|e| format!("no WebView2 runtime: {e}"))?;
    if take_pwstr(version).is_empty() {
        return Err("no WebView2 runtime".to_owned());
    }
    // SAFETY: GTK already runs this thread as a single-threaded apartment; a mode clash is not an error here.
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    call_event("runtime", "found");
    let class = register_class()?;
    let title = wide(title);
    // SAFETY: a top-level window of our registered class, on this thread.
    let hwnd = unsafe {
        CreateWindowExW(
            Default::default(),
            class,
            PCWSTR(title.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            1100,
            720,
            None,
            None,
            GetModuleHandleW(None).ok().map(Into::into),
            None,
        )
    }
    .map_err(|e| e.to_string())?;
    call_event("window", "made");
    let call_url = url.to_owned();
    let folder = user_data();
    let environment_ready =
        CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |error, environment| {
            error?;
            call_event("engine", "ready");
            let Some(environment) = environment else { return Ok(()) };
            let pending = Pending { environment, url: call_url.clone(), allowed };
            PENDING.with_borrow_mut(|p| p.insert(hwnd.0 as isize, pending));
            // SAFETY: a message to our own window, handled by its procedure.
            unsafe { PostMessageW(Some(hwnd), WM_ENGINE_READY, WPARAM(0), LPARAM(0)) }
        }));
    // SAFETY: the folder string outlives the call; the answer comes through the handler.
    unsafe {
        CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), PCWSTR(folder.as_ptr()), None, &environment_ready)
    }
    .map_err(|e| {
        // SAFETY: the window made above, now useless.
        let _ = unsafe { DestroyWindow(hwnd) };
        e.to_string()
    })?;
    call_event("window", "open");
    Ok(())
}

unsafe fn attach(
    hwnd: HWND,
    controller: &ICoreWebView2Controller,
    call_url: &str,
    allowed: Allowed,
) -> windows::core::Result<()> {
    // SAFETY: called on the controller's thread, as its creation handler.
    unsafe {
        CONTROLLERS.with_borrow_mut(|c| c.insert(hwnd.0 as isize, controller.clone()));
        fit(hwnd);
        controller.SetIsVisible(true)?;
        let page = controller.CoreWebView2()?;
        let mut token = 0;

        let origin = call_url.to_owned();
        page.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                let media = permission_kind(kind);
                let grant = media.is_some() && allowed(&uri, &origin) && !uri.starts_with("about:");
                args.SetState(if grant {
                    COREWEBVIEW2_PERMISSION_STATE_ALLOW
                } else {
                    COREWEBVIEW2_PERMISSION_STATE_DENY
                })?;
                call_event(
                    "permission",
                    &format!("{} {}", media.unwrap_or("other"), if grant { "granted" } else { "denied" }),
                );
                Ok(())
            })),
            &mut token,
        )?;

        let origin = call_url.to_owned();
        page.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                if !allowed(&uri, &origin) {
                    args.SetCancel(true)?;
                    let mut user = Default::default();
                    args.IsUserInitiated(&mut user)?;
                    call_event("left for the browser", &uri);
                    if user.as_bool() && (uri.starts_with("https://") || uri.starts_with("http://")) {
                        open_in_browser(&uri);
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;

        page.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                args.SetHandled(true)?;
                call_event("left for the browser", &uri);
                if uri.starts_with("https://") || uri.starts_with("http://") {
                    open_in_browser(&uri);
                }
                Ok(())
            })),
            &mut token,
        )?;

        page.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |page, _| {
                if let Some(page) = page {
                    let mut uri = PWSTR::null();
                    page.Source(&mut uri)?;
                    call_event("loaded", &take_pwstr(uri));
                }
                Ok(())
            })),
            &mut token,
        )?;

        page.add_WindowCloseRequested(
            &WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
                windows::Win32::UI::WindowsAndMessaging::PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0))
            })),
            &mut token,
        )?;

        let url = CoTaskMemPWSTR::from(call_url);
        page.Navigate(*url.as_ref().as_pcwstr())?;
    }
    Ok(())
}
