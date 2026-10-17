//! The call and sign-in windows on macOS: the page in WKWebView, in a window
//! of its own on the main thread, which GTK's run loop shares with AppKit.

#![allow(unsafe_code)]

use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::runtime::ProtocolObject;
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_app_kit::{NSBackingStoreType, NSWindow, NSWindowStyleMask, NSWorkspace};
use objc2_foundation::{
    NSArray, NSDictionary, NSHTTPCookie, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL,
    NSURLRequest,
};
use objc2_web_kit::{
    WKFrameInfo, WKMediaCaptureType, WKNavigation, WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate,
    WKPermissionDecision, WKSecurityOrigin, WKUIDelegate, WKWebView, WKWebViewConfiguration, WKWebsiteDataStore,
    WKWindowFeatures,
};

use crate::{Cookie, SessionSignIn, SignIn, call_event};

type Allowed = fn(&str, &str) -> bool;

enum Mode {
    Call(Allowed, Vec<Cookie>),
    SignIn(SignIn),
    Session(SessionSignIn),
}

pub struct Ivars {
    call_url: String,
    mode: Mode,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "RvCallDelegate"]
    #[ivars = Ivars]
    struct CallDelegate;

    unsafe impl NSObjectProtocol for CallDelegate {}

    unsafe impl WKUIDelegate for CallDelegate {
        #[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
        fn media_capture(
            &self,
            _web: &WKWebView,
            origin: &WKSecurityOrigin,
            _frame: &WKFrameInfo,
            kind: WKMediaCaptureType,
            handler: &block2::DynBlock<dyn Fn(WKPermissionDecision)>,
        ) {
            let address = origin_address(origin);
            let grant =
                matches!(&self.ivars().mode, Mode::Call(allowed, _) if allowed(&address, &self.ivars().call_url));
            let what = match kind {
                WKMediaCaptureType::Camera => "camera",
                WKMediaCaptureType::Microphone => "microphone",
                _ => "camera and microphone",
            };
            call_event("permission", &format!("{what} {}", if grant { "granted" } else { "denied" }));
            handler.call((if grant { WKPermissionDecision::Grant } else { WKPermissionDecision::Deny },));
        }

        #[unsafe(method_id(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
        fn create_window(
            &self,
            web: &WKWebView,
            _configuration: &WKWebViewConfiguration,
            action: &WKNavigationAction,
            _features: &WKWindowFeatures,
        ) -> Option<Retained<WKWebView>> {
            if let Some(target) = target_of(action) {
                if stays_in_window(&self.ivars().mode, &target) {
                    // SAFETY: loading, in this window, the request WebKit wanted a new one for.
                    unsafe { web.loadRequest(&action.request()) };
                } else {
                    call_event("left for the browser", &target);
                    open_in_browser(&target);
                }
            }
            None
        }

        #[unsafe(method(webViewDidClose:))]
        fn did_close(&self, web: &WKWebView) {
            if let Some(window) = web.window() {
                window.close();
            }
        }
    }

    unsafe impl WKNavigationDelegate for CallDelegate {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide(
            &self,
            web: &WKWebView,
            action: &WKNavigationAction,
            handler: &block2::DynBlock<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            let target = target_of(action).unwrap_or_default();
            let allowed = match &self.ivars().mode {
                Mode::Call(allowed, cookies) => {
                    allowed(&target, &self.ivars().call_url) || (!cookies.is_empty() && !is_main_frame(action))
                }
                Mode::Session(session) if (session.done)(&target) => {
                    handler.call((WKNavigationActionPolicy::Cancel,));
                    call_event("sign-in", "session reached");
                    harvest(web, session.clone(), target);
                    return;
                }
                Mode::Session(session) => (session.page)(&target) || !is_main_frame(action),
                Mode::SignIn(sign_in) if (sign_in.redirect)(&target) => {
                    handler.call((WKNavigationActionPolicy::Cancel,));
                    call_event("sign-in", "redirect caught");
                    (sign_in.caught)(target);
                    if let Some(window) = web.window() {
                        window.close();
                    }
                    return;
                }
                Mode::SignIn(sign_in) => (sign_in.page)(&target) || !is_main_frame(action),
            };
            if allowed {
                handler.call((WKNavigationActionPolicy::Allow,));
                return;
            }
            handler.call((WKNavigationActionPolicy::Cancel,));
            call_event("left for the browser", &target);
            if target.starts_with("https://") || target.starts_with("http://") {
                open_in_browser(&target);
            }
        }

        #[unsafe(method(webView:didFinishNavigation:))]
        fn finished(&self, web: &WKWebView, _navigation: Option<&WKNavigation>) {
            // SAFETY: reading the page's address on the main thread.
            let url = unsafe { web.URL() }.and_then(|u| u.absoluteString()).map(|s| s.to_string());
            call_event("loaded", &url.unwrap_or_default());
        }
    }
);

impl CallDelegate {
    fn new(mtm: MainThreadMarker, call_url: &str, mode: Mode) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars { call_url: call_url.to_owned(), mode });
        // SAFETY: NSObject's init on a freshly allocated instance.
        unsafe { msg_send![super(this), init] }
    }
}

/// Reads the page's cookies for the session's address, hands them on and
/// closes the window. The store is the window's own, kept in memory only.
fn harvest(web: &WKWebView, session: SessionSignIn, reached: String) {
    let rest = session.cookie_url.split_once("://").map_or(session.cookie_url, |(_, rest)| rest);
    let host = rest.split(['/', ':', '?', '#']).next().unwrap_or_default().to_ascii_lowercase();
    let window = web.window();
    let read = block2::RcBlock::new(move |list: std::ptr::NonNull<NSArray<NSHTTPCookie>>| {
        // SAFETY: the array WebKit hands the completion, alive for the call.
        let list = unsafe { list.as_ref() };
        let cookies: Vec<Cookie> = list
            .iter()
            .filter_map(|cookie| {
                let domain = cookie.domain().to_string();
                let bare = domain.trim_start_matches('.');
                (host == bare || host.ends_with(&format!(".{bare}"))).then(|| Cookie {
                    name: cookie.name().to_string(),
                    value: cookie.value().to_string(),
                    domain,
                    path: cookie.path().to_string(),
                    secure: cookie.isSecure(),
                    http_only: cookie.isHTTPOnly(),
                })
            })
            .collect();
        call_event("sign-in", &format!("{} cookies read", cookies.len()));
        (session.caught)(reached.clone(), cookies);
        if let Some(window) = &window {
            window.close();
        }
    });
    // SAFETY: the view's own store, read on the main thread.
    unsafe { web.configuration().websiteDataStore().httpCookieStore().getAllCookies(&read) };
}

fn ns_cookie(cookie: &Cookie) -> Option<Retained<NSHTTPCookie>> {
    let truth = |on: bool| NSString::from_str(if on { "TRUE" } else { "FALSE" });
    let pairs = [
        ("Name", NSString::from_str(&cookie.name)),
        ("Value", NSString::from_str(&cookie.value)),
        ("Domain", NSString::from_str(&cookie.domain)),
        ("Path", NSString::from_str(&cookie.path)),
        ("Secure", truth(cookie.secure)),
        ("HttpOnly", truth(cookie.http_only)),
    ];
    let keys: Vec<Retained<NSString>> = pairs.iter().map(|(k, _)| NSString::from_str(k)).collect();
    let key_refs: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
    let values: Vec<&AnyObject> = pairs.iter().map(|(_, v)| -> &AnyObject { v }).collect();
    let properties = NSDictionary::from_slices(&key_refs, &values);
    // SAFETY: a cookie made from a dictionary of the documented property names.
    unsafe { NSHTTPCookie::cookieWithProperties(&properties) }
}

fn origin_address(origin: &WKSecurityOrigin) -> String {
    // SAFETY: plain property reads of the origin WebKit hands us.
    let (scheme, host, port) = unsafe { (origin.protocol().to_string(), origin.host().to_string(), origin.port()) };
    if port > 0 { format!("{scheme}://{host}:{port}") } else { format!("{scheme}://{host}") }
}

/// A sign-in page opened in a new window (Slack's workspace list does) stays in this one.
fn stays_in_window(mode: &Mode, target: &str) -> bool {
    match mode {
        Mode::Session(session) => (session.page)(target) || (session.done)(target),
        Mode::SignIn(sign_in) => (sign_in.page)(target) || (sign_in.redirect)(target),
        Mode::Call(..) => false,
    }
}

fn target_of(action: &WKNavigationAction) -> Option<String> {
    // SAFETY: reading the request of the action WebKit hands us.
    let request = unsafe { action.request() };
    request.URL().and_then(|u| u.absoluteString()).map(|s| s.to_string())
}

/// The page's own frames (Infomaniak's reCAPTCHA) load where they are; only
/// the page itself leaving goes to the browser.
fn is_main_frame(action: &WKNavigationAction) -> bool {
    // SAFETY: reading the target frame of the action WebKit hands us.
    unsafe { action.targetFrame() }.is_none_or(|frame| unsafe { frame.isMainFrame() })
}

fn open_in_browser(target: &str) {
    if let Some(url) = NSURL::URLWithString(&NSString::from_str(target)) {
        NSWorkspace::sharedWorkspace().openURL(&url);
    }
}

type Open = (Retained<NSWindow>, Retained<WKWebView>, Retained<CallDelegate>);

/// Loads `address` once every cookie is in the view's store.
fn load_with(web: &Retained<WKWebView>, address: &Retained<NSURL>, cookies: Vec<Cookie>) {
    let made: Vec<Retained<NSHTTPCookie>> = cookies.iter().filter_map(ns_cookie).collect();
    // SAFETY: WebKit calls on the main thread.
    let store = unsafe { web.configuration().websiteDataStore().httpCookieStore() };
    let left = std::rc::Rc::new(std::cell::Cell::new(made.len()));
    let (web, address) = (web.clone(), address.clone());
    let load = std::rc::Rc::new(move || {
        // SAFETY: loading the page on the main thread.
        unsafe { web.loadRequest(&NSURLRequest::requestWithURL(&address)) };
    });
    if made.is_empty() {
        return load();
    }
    for cookie in made {
        let (left, load) = (left.clone(), load.clone());
        let set = block2::RcBlock::new(move || {
            left.set(left.get() - 1);
            if left.get() == 0 {
                load();
            }
        });
        // SAFETY: the view's own store, written on the main thread.
        unsafe { store.setCookie_completionHandler(&cookie, Some(&set)) };
    }
}

thread_local! {
    static OPEN: RefCell<Vec<Open>> = RefCell::default();
}

/// The call at `url` in a window titled `title`; `allowed(address, url)` says
/// where it may go and which origin gets the camera and the microphone.
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
    let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
    let address = NSURL::URLWithString(&NSString::from_str(url)).ok_or("not a URL")?;
    OPEN.with_borrow_mut(|open| open.retain(|(window, _, _)| window.isVisible()));
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1100.0, 720.0));
    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable;
    // SAFETY: a window made, configured and shown on the main thread.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            frame,
            style,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: kept alive in OPEN, so AppKit must not release it on close.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str(title));
    // SAFETY: WebKit objects made and used on the main thread.
    let cookies = match &mode {
        Mode::Call(_, cookies) => cookies.clone(),
        _ => Vec::new(),
    };
    let private = matches!(mode, Mode::Session(_)) || !cookies.is_empty();
    let web = unsafe {
        let configuration = WKWebViewConfiguration::new(mtm);
        if private {
            configuration.setWebsiteDataStore(&WKWebsiteDataStore::nonPersistentDataStore(mtm));
        }
        WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &configuration)
    };
    let delegate = CallDelegate::new(mtm, url, mode);
    // SAFETY: the delegate outlives the view: both are kept in OPEN.
    unsafe {
        web.setUIDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        web.setNavigationDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    }
    load_with(&web, &address, cookies);
    window.setContentView(Some(&web));
    window.center();
    window.makeKeyAndOrderFront(None);
    OPEN.with_borrow_mut(|open| open.push((window, web, delegate)));
    call_event("window", "open");
    Ok(())
}
