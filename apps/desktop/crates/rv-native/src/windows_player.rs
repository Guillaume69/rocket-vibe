//! The inline video player on Windows: WebView2 in a child window of the
//! app's own, laid over the card and cut to the message list, since a GTK
//! window cannot hold a native view among its widgets. The page is served
//! from a folder under a host name of ours, so the embed gets a Referer.

#![allow(unsafe_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::{Rc, Weak};

use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW, CreateCoreWebView2EnvironmentWithOptions,
    GetAvailableCoreWebView2BrowserVersionString, ICoreWebView2_3, ICoreWebView2Controller, ICoreWebView2Environment,
    ICoreWebView2EnvironmentOptions, ICoreWebView2NavigationStartingEventArgs,
};
use webview2_com::{
    CoTaskMemPWSTR, CoreWebView2EnvironmentOptions, CreateCoreWebView2ControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, NavigationCompletedEventHandler, NavigationStartingEventHandler,
    NewWindowRequestedEventHandler, take_pwstr,
};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{BLACK_BRUSH, GetStockObject, HBRUSH};
use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GWL_STYLE, GetWindowLongPtrW, HWND_TOP, PostMessageW,
    RegisterClassW, SW_HIDE, SWP_NOACTIVATE, SWP_SHOWWINDOW, SetWindowLongPtrW, SetWindowPos, ShowWindow, WM_APP,
    WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
};
use windows::core::{Interface, PCWSTR, PWSTR, w};

use crate::windows_call::{open_in_browser, wide};
use crate::{Decide, Go, Rect, player_event};

const WM_ENGINE_READY: u32 = WM_APP + 2;

struct Inner {
    clip: HWND,
    controller: Option<ICoreWebView2Controller>,
    /// The clip window's rectangle in the parent and the page's in the clip, in pixels.
    placed: Option<(RECT, RECT)>,
    wanted: Option<(RECT, RECT)>,
}

/// A player on screen; dropping it closes the page.
pub struct Player(Rc<RefCell<Inner>>);

struct Pending {
    player: Weak<RefCell<Inner>>,
    url: String,
    decide: Decide,
}

thread_local! {
    static ENVIRONMENT: RefCell<Option<ICoreWebView2Environment>> = const { RefCell::new(None) };
    static STARTING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static PENDING: RefCell<HashMap<isize, Pending>> = RefCell::default();
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if message == WM_ENGINE_READY {
        make_page(hwnd);
        return LRESULT(0);
    }
    // SAFETY: the default handling of our own window's messages.
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

fn register_class() -> Result<PCWSTR, String> {
    thread_local!(static REGISTERED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });
    let name = w!("RocketVibePlayer");
    if REGISTERED.get() {
        return Ok(name);
    }
    // SAFETY: a class whose procedure and strings are static.
    unsafe {
        let instance = GetModuleHandleW(None).map_err(|e| e.to_string())?;
        let class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance.into(),
            hbrBackground: HBRUSH(GetStockObject(BLACK_BRUSH).0),
            lpszClassName: name,
            ..Default::default()
        };
        if RegisterClassW(&class) == 0 {
            return Err("the player window class could not be registered".to_owned());
        }
    }
    REGISTERED.set(true);
    Ok(name)
}

fn folder() -> std::path::PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("rocket-vibe-rs")
}

/// Every clip window waiting for the engine gets its page once it is there.
fn engine_ready() {
    let waiting: Vec<isize> = PENDING.with_borrow(|p| p.keys().copied().collect());
    for hwnd in waiting {
        // SAFETY: a message to our own window, handled by its procedure.
        let _ = unsafe { PostMessageW(Some(HWND(hwnd as _)), WM_ENGINE_READY, WPARAM(0), LPARAM(0)) };
    }
}

fn start_engine() -> Result<(), String> {
    if STARTING.get() {
        return Ok(());
    }
    STARTING.set(true);
    let data = wide(&folder().join("webview2-player").to_string_lossy());
    let options = CoreWebView2EnvironmentOptions::default();
    // SAFETY: the options object is ours until it is handed over below.
    unsafe { options.set_additional_browser_arguments("--autoplay-policy=no-user-gesture-required".to_owned()) };
    let options: ICoreWebView2EnvironmentOptions = options.into();
    let ready = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |error, environment| {
        STARTING.set(false);
        error?;
        player_event("engine", "ready");
        ENVIRONMENT.set(environment);
        engine_ready();
        Ok(())
    }));
    // SAFETY: the folder string outlives the call; the answer comes through the handler.
    unsafe { CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), PCWSTR(data.as_ptr()), &options, &ready) }
        .map_err(|e| {
            STARTING.set(false);
            e.to_string()
        })
}

fn make_page(clip: HWND) {
    let Some(environment) = ENVIRONMENT.with_borrow(Clone::clone) else { return };
    let Some(Pending { player, url, decide }) = PENDING.with_borrow_mut(|p| p.remove(&(clip.0 as isize))) else {
        return;
    };
    let controller_ready = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(move |error, controller| {
        error?;
        let Some(controller) = controller else { return Ok(()) };
        let Some(player) = player.upgrade() else {
            // SAFETY: a controller of this thread, no longer wanted.
            let _ = unsafe { controller.Close() };
            return Ok(());
        };
        // SAFETY: the controller and its page answer on this thread.
        unsafe { attach(&player, &controller, &url, decide) }
    }));
    // SAFETY: the clip window outlives the request, which answers on this thread.
    if let Err(e) = unsafe { environment.CreateCoreWebView2Controller(clip, &controller_ready) } {
        player_event("page", &format!("not made: {e}"));
    }
}

fn navigation(
    args: Option<&ICoreWebView2NavigationStartingEventArgs>,
    main_frame: bool,
    decide: Decide,
) -> windows::core::Result<()> {
    let Some(args) = args else { return Ok(()) };
    let mut uri = PWSTR::null();
    let mut user = Default::default();
    // SAFETY: reading and answering the event WebView2 hands us, on its thread.
    unsafe {
        args.Uri(&mut uri)?;
        args.IsUserInitiated(&mut user)?;
    }
    let uri = take_pwstr(uri);
    let go = decide(&uri, main_frame, user.as_bool());
    if go != Go::Allow {
        // SAFETY: as above.
        unsafe { args.SetCancel(true)? };
        player_event("left for the browser", &uri);
    }
    if go == Go::Browser {
        open_in_browser(&uri);
    }
    Ok(())
}

unsafe fn attach(
    player: &Rc<RefCell<Inner>>,
    controller: &ICoreWebView2Controller,
    url: &str,
    decide: Decide,
) -> windows::core::Result<()> {
    // SAFETY: called on the controller's thread, as its creation handler.
    unsafe {
        let page = controller.CoreWebView2()?;
        let host = url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or_default();
        let (host, data) = (wide(host), wide(&folder().join("player").to_string_lossy()));
        page.cast::<ICoreWebView2_3>()?.SetVirtualHostNameToFolderMapping(
            PCWSTR(host.as_ptr()),
            PCWSTR(data.as_ptr()),
            COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW,
        )?;
        let mut token = 0;
        page.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| navigation(args.as_ref(), true, decide))),
            &mut token,
        )?;
        page.add_FrameNavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| navigation(args.as_ref(), false, decide))),
            &mut token,
        )?;
        page.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                args.SetHandled(true)?;
                player_event("left for the browser", &uri);
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
                    player_event("loaded", &take_pwstr(uri));
                }
                Ok(())
            })),
            &mut token,
        )?;
        let mut inner = player.borrow_mut();
        inner.controller = Some(controller.clone());
        let wanted = inner.wanted;
        inner.placed = None;
        drop(inner);
        apply(player, wanted);
        let url = CoTaskMemPWSTR::from(url);
        page.Navigate(*url.as_ref().as_pcwstr())?;
    }
    Ok(())
}

fn apply(player: &Rc<RefCell<Inner>>, wanted: Option<(RECT, RECT)>) {
    let mut inner = player.borrow_mut();
    inner.wanted = wanted;
    if inner.placed == wanted {
        return;
    }
    let clip = inner.clip;
    // SAFETY: our own child window and its controller, on this thread.
    unsafe {
        match wanted {
            None => {
                let _ = ShowWindow(clip, SW_HIDE);
            }
            Some((at, page)) => {
                let _ = SetWindowPos(
                    clip,
                    Some(HWND_TOP),
                    at.left,
                    at.top,
                    at.right - at.left,
                    at.bottom - at.top,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
                if let Some(controller) = &inner.controller {
                    let _ = controller.SetBounds(page);
                    let _ = controller.SetIsVisible(true);
                }
            }
        }
    }
    if inner.controller.is_some() || wanted.is_none() {
        inner.placed = wanted;
    }
}

/// A player for the page at `url` (holding `html`) in the window `window`;
/// `decide` says where it may go. Hidden until placed. Err when the
/// WebView2 runtime is missing.
pub fn player(window: isize, url: &str, html: &str, decide: Decide) -> Result<Player, String> {
    let mut version = PWSTR::null();
    // SAFETY: WebView2's own lookup of an installed runtime.
    unsafe { GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut version) }
        .map_err(|e| format!("no WebView2 runtime: {e}"))?;
    if take_pwstr(version).is_empty() {
        return Err("no WebView2 runtime".to_owned());
    }
    // SAFETY: GTK already runs this thread as a single-threaded apartment; a mode clash is not an error here.
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let name = url.rsplit('/').next().filter(|n| n.ends_with(".html")).ok_or("not a page address")?;
    let pages = folder().join("player");
    std::fs::create_dir_all(&pages).and_then(|()| std::fs::write(pages.join(name), html)).map_err(|e| e.to_string())?;
    let class = register_class()?;
    let parent = HWND(window as _);
    // SAFETY: GTK paints the whole window; the player's child window must be left out of it.
    unsafe {
        let style = GetWindowLongPtrW(parent, GWL_STYLE);
        SetWindowLongPtrW(parent, GWL_STYLE, style | WS_CLIPCHILDREN.0 as isize);
    }
    // SAFETY: a hidden child window of the app's own, on this thread.
    let clip = unsafe {
        CreateWindowExW(
            Default::default(),
            class,
            PCWSTR::null(),
            WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            0,
            0,
            0,
            0,
            Some(parent),
            None,
            GetModuleHandleW(None).ok().map(Into::into),
            None,
        )
    }
    .map_err(|e| e.to_string())?;
    let inner = Rc::new(RefCell::new(Inner { clip, controller: None, placed: None, wanted: None }));
    let pending = Pending { player: Rc::downgrade(&inner), url: url.to_owned(), decide };
    PENDING.with_borrow_mut(|p| p.insert(clip.0 as isize, pending));
    if ENVIRONMENT.with_borrow(Option::is_some) {
        engine_ready();
    } else if let Err(e) = start_engine() {
        PENDING.with_borrow_mut(|p| p.remove(&(clip.0 as isize)));
        // SAFETY: the window made above, now useless.
        let _ = unsafe { DestroyWindow(clip) };
        return Err(e);
    }
    player_event("window", "made");
    Ok(Player(inner))
}

fn pixels(r: Rect, scale: f64) -> RECT {
    let p = |v: f64| (v * scale).round() as i32;
    RECT { left: p(r.x), top: p(r.y), right: p(r.x + r.width), bottom: p(r.y + r.height) }
}

impl Player {
    /// Lays the page over `card`, showing only what falls inside `clip`; both
    /// in the window's logical pixels, `scale` device pixels each.
    pub fn place(&self, card: Rect, clip: Rect, scale: f64) {
        let (card, clip) = (pixels(card, scale), pixels(clip, scale));
        let shown = RECT {
            left: card.left.max(clip.left),
            top: card.top.max(clip.top),
            right: card.right.min(clip.right),
            bottom: card.bottom.min(clip.bottom),
        };
        if shown.right <= shown.left || shown.bottom <= shown.top {
            return self.hide();
        }
        let page = RECT {
            left: card.left - shown.left,
            top: card.top - shown.top,
            right: card.right - shown.left,
            bottom: card.bottom - shown.top,
        };
        apply(&self.0, Some((shown, page)));
    }

    pub fn hide(&self) {
        apply(&self.0, None);
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        let mut inner = self.0.borrow_mut();
        PENDING.with_borrow_mut(|p| p.remove(&(inner.clip.0 as isize)));
        if let Some(controller) = inner.controller.take() {
            // SAFETY: closing the engine before its window goes.
            let _ = unsafe { controller.Close() };
        }
        // SAFETY: our own child window.
        let _ = unsafe { DestroyWindow(inner.clip) };
        player_event("closed", "");
    }
}
