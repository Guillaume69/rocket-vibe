//! The call and sign-in windows on Windows: the page in WebView2, the Edge
//! engine Windows 10 and 11 carry, in a window of its own. WebView2 answers
//! on this thread through window messages, which GTK's loop dispatches.

#![allow(unsafe_code)]

use std::cell::RefCell;
use std::collections::HashMap;

use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
    COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY, CreateCoreWebView2EnvironmentWithOptions,
    GetAvailableCoreWebView2BrowserVersionString, ICoreWebView2, ICoreWebView2_2, ICoreWebView2Controller,
    ICoreWebView2CookieList, ICoreWebView2CookieManager, ICoreWebView2Environment,
};
use webview2_com::{
    CoTaskMemPWSTR, CreateCoreWebView2ControllerCompletedHandler, CreateCoreWebView2EnvironmentCompletedHandler,
    GetCookiesCompletedHandler, NavigationCompletedEventHandler, NavigationStartingEventHandler,
    NewWindowRequestedEventHandler, PermissionRequestedEventHandler, WindowCloseRequestedEventHandler, take_pwstr,
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

use crate::{Cookie, SessionSignIn, SignIn, call_event};

type Allowed = fn(&str, &str) -> bool;

/// A sign-in page opened in a new window (Slack's workspace list does) stays in this one.
fn stays_in_window(mode: &Mode, uri: &str) -> bool {
    match mode {
        Mode::Session(session) => (session.page)(uri) || (session.done)(uri),
        Mode::SignIn(sign_in) => (sign_in.page)(uri) || (sign_in.redirect)(uri),
        Mode::Call(..) => false,
    }
}

#[derive(Clone)]
enum Mode {
    Call(Allowed, Vec<Cookie>),
    SignIn(SignIn),
    Session(SessionSignIn),
}

/// Posted to a call window once its engine is ready: the page is made from
/// the window's own message, not from inside the engine's creation, which
/// can answer before it returns and hang when called back into.
const WM_ENGINE_READY: u32 = WM_APP + 1;

struct Pending {
    environment: ICoreWebView2Environment,
    url: String,
    mode: Mode,
}

thread_local! {
    static CONTROLLERS: RefCell<HashMap<isize, ICoreWebView2Controller>> = RefCell::default();
    static PENDING: RefCell<HashMap<isize, Pending>> = RefCell::default();
}

fn make_page(hwnd: HWND) {
    let Some(pending) = PENDING.with_borrow_mut(|p| p.remove(&(hwnd.0 as isize))) else { return };
    let Pending { environment, url, mode } = pending;
    let controller_ready = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(move |error, controller| {
        error?;
        let Some(controller) = controller else { return Ok(()) };
        // SAFETY: the controller and its page answer on this thread.
        unsafe { attach(hwnd, &controller, &url, mode.clone()) }
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
    open(url, title, Mode::Call(allowed, Vec::new()))
}

/// [`call_window`], the page's store holding `cookies` before it loads.
pub fn call_window_with(url: &str, title: &str, allowed: Allowed, cookies: Vec<Cookie>) -> Result<(), String> {
    open(url, title, Mode::Call(allowed, cookies))
}

/// The sign-in page at `url` in a window titled `title`, see [`SessionSignIn`].
pub fn session_sign_in_window(url: &str, title: &str, sign_in: SessionSignIn) -> Result<(), String> {
    open(url, title, Mode::Session(sign_in))
}

/// The sign-in page at `url` in a window titled `title`, see [`SignIn`].
pub fn sign_in_window(url: &str, title: &str, sign_in: SignIn) -> Result<(), String> {
    open(url, title, Mode::SignIn(sign_in))
}

fn open(url: &str, title: &str, mode: Mode) -> Result<(), String> {
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
            let pending = Pending { environment, url: call_url.clone(), mode: mode.clone() };
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
    mode: Mode,
) -> windows::core::Result<()> {
    // SAFETY: called on the controller's thread, as its creation handler.
    let mode_for_cookies = mode.clone();
    unsafe {
        CONTROLLERS.with_borrow_mut(|c| c.insert(hwnd.0 as isize, controller.clone()));
        fit(hwnd);
        controller.SetIsVisible(true)?;
        let page = controller.CoreWebView2()?;
        let mut token = 0;

        let (origin, kept) = (call_url.to_owned(), mode.clone());
        page.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                let media = permission_kind(kind);
                let call = matches!(&kept, Mode::Call(allowed, _) if allowed(&uri, &origin));
                let grant = media.is_some() && call && !uri.starts_with("about:");
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
        let args_page = page.clone();
        let (opener, opened_page) = (mode.clone(), page.clone());
        page.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                let allowed = match &mode {
                    Mode::Call(allowed, _) => allowed(&uri, &origin),
                    Mode::Session(session) if (session.done)(&uri) => {
                        args.SetCancel(true)?;
                        call_event("sign-in", "session reached");
                        harvest(hwnd, &args_page, session.clone(), uri);
                        return Ok(());
                    }
                    Mode::Session(session) => (session.page)(&uri),
                    Mode::SignIn(sign_in) if (sign_in.redirect)(&uri) => {
                        args.SetCancel(true)?;
                        call_event("sign-in", "redirect caught");
                        (sign_in.caught)(uri);
                        windows::Win32::UI::WindowsAndMessaging::PostMessageW(
                            Some(hwnd),
                            WM_CLOSE,
                            WPARAM(0),
                            LPARAM(0),
                        )?;
                        return Ok(());
                    }
                    Mode::SignIn(sign_in) => (sign_in.page)(&uri),
                };
                if !allowed {
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
                if stays_in_window(&opener, &uri) {
                    let url = CoTaskMemPWSTR::from(uri.as_str());
                    opened_page.Navigate(*url.as_ref().as_pcwstr())?;
                    return Ok(());
                }
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

        if let Mode::Call(_, cookies) = &mode_for_cookies
            && !cookies.is_empty()
        {
            let manager = cookie_manager(&page)?;
            for cookie in cookies {
                let made = manager.CreateCookie(
                    PCWSTR(wide(&cookie.name).as_ptr()),
                    PCWSTR(wide(&cookie.value).as_ptr()),
                    PCWSTR(wide(&cookie.domain).as_ptr()),
                    PCWSTR(wide(&cookie.path).as_ptr()),
                )?;
                made.SetIsSecure(cookie.secure)?;
                made.SetIsHttpOnly(cookie.http_only)?;
                manager.AddOrUpdateCookie(&made)?;
            }
        }
        let url = CoTaskMemPWSTR::from(call_url);
        page.Navigate(*url.as_ref().as_pcwstr())?;
    }
    Ok(())
}

/// The engine's cookie store, shared by every window of the app's profile.
unsafe fn cookie_manager(page: &ICoreWebView2) -> windows::core::Result<ICoreWebView2CookieManager> {
    // SAFETY: an interface cast and a property read on the page's own thread.
    unsafe { windows::core::Interface::cast::<ICoreWebView2_2>(page)?.CookieManager() }
}

/// Reads the session's cookies, wipes the profile's store so nothing of it
/// stays on disk, hands them on and closes the window.
fn harvest(hwnd: HWND, page: &ICoreWebView2, session: SessionSignIn, reached: String) {
    // SAFETY: the page and its cookie store answer on this thread.
    let manager = match unsafe { cookie_manager(page) } {
        Ok(manager) => manager,
        Err(e) => {
            call_event("sign-in", &format!("no cookie store: {e}"));
            (session.caught)(reached, Vec::new());
            // SAFETY: a message to our own window.
            let _ = unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) };
            return;
        }
    };
    let kept = manager.clone();
    let read = GetCookiesCompletedHandler::create(Box::new(move |error, list| {
        let cookies = if error.is_ok() { list.map(|l| cookies_of(&l)).unwrap_or_default() } else { Vec::new() };
        // SAFETY: wiping the store the cookies were just read from, on its thread.
        let _ = unsafe { kept.DeleteAllCookies() };
        call_event("sign-in", &format!("{} cookies read", cookies.len()));
        (session.caught)(reached.clone(), cookies);
        // SAFETY: a message to our own window.
        unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) }
    }));
    let address = wide(session.cookie_url);
    // SAFETY: the address outlives the call; the answer comes through the handler.
    if let Err(e) = unsafe { manager.GetCookies(PCWSTR(address.as_ptr()), &read) } {
        call_event("sign-in", &format!("cookies not read: {e}"));
    }
}

fn cookies_of(list: &ICoreWebView2CookieList) -> Vec<Cookie> {
    let mut count = 0u32;
    // SAFETY: reading the list the engine handed us, on its thread.
    if unsafe { list.Count(&mut count) }.is_err() {
        return Vec::new();
    }
    (0..count)
        .filter_map(|index| {
            // SAFETY: an index below the list's own count.
            let cookie = unsafe { list.GetValueAtIndex(index) }.ok()?;
            let text = |read: &dyn Fn(*mut PWSTR) -> windows::core::Result<()>| {
                let mut value = PWSTR::null();
                read(&mut value).ok().map(|()| take_pwstr(value))
            };
            // SAFETY: property reads of the cookie the engine handed us.
            unsafe {
                let mut secure = windows::core::BOOL::default();
                let mut http_only = windows::core::BOOL::default();
                cookie.IsSecure(&mut secure).ok()?;
                cookie.IsHttpOnly(&mut http_only).ok()?;
                Some(Cookie {
                    name: text(&|v| cookie.Name(v))?,
                    value: text(&|v| cookie.Value(v))?,
                    domain: text(&|v| cookie.Domain(v))?,
                    path: text(&|v| cookie.Path(v))?,
                    secure: secure.as_bool(),
                    http_only: http_only.as_bool(),
                })
            }
        })
        .collect()
}
