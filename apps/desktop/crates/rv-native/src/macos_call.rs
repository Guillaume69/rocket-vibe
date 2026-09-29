//! The call window on macOS: the meeting page in WKWebView, in a window of
//! its own on the main thread, which GTK's run loop shares with AppKit.

#![allow(unsafe_code)]

use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_app_kit::{NSBackingStoreType, NSWindow, NSWindowStyleMask, NSWorkspace};
use objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL, NSURLRequest};
use objc2_web_kit::{
    WKFrameInfo, WKMediaCaptureType, WKNavigation, WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate,
    WKPermissionDecision, WKSecurityOrigin, WKUIDelegate, WKWebView, WKWebViewConfiguration, WKWindowFeatures,
};

use crate::call_event;

type Allowed = fn(&str, &str) -> bool;

pub struct Ivars {
    call_url: String,
    allowed: Allowed,
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
            let grant = (self.ivars().allowed)(&address, &self.ivars().call_url);
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
            _web: &WKWebView,
            _configuration: &WKWebViewConfiguration,
            action: &WKNavigationAction,
            _features: &WKWindowFeatures,
        ) -> Option<Retained<WKWebView>> {
            if let Some(target) = target_of(action) {
                call_event("left for the browser", &target);
                open_in_browser(&target);
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
            _web: &WKWebView,
            action: &WKNavigationAction,
            handler: &block2::DynBlock<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            let target = target_of(action).unwrap_or_default();
            if (self.ivars().allowed)(&target, &self.ivars().call_url) {
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
    fn new(mtm: MainThreadMarker, call_url: &str, allowed: Allowed) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars { call_url: call_url.to_owned(), allowed });
        // SAFETY: NSObject's init on a freshly allocated instance.
        unsafe { msg_send![super(this), init] }
    }
}

fn origin_address(origin: &WKSecurityOrigin) -> String {
    // SAFETY: plain property reads of the origin WebKit hands us.
    let (scheme, host, port) = unsafe { (origin.protocol().to_string(), origin.host().to_string(), origin.port()) };
    if port > 0 { format!("{scheme}://{host}:{port}") } else { format!("{scheme}://{host}") }
}

fn target_of(action: &WKNavigationAction) -> Option<String> {
    // SAFETY: reading the request of the action WebKit hands us.
    let request = unsafe { action.request() };
    request.URL().and_then(|u| u.absoluteString()).map(|s| s.to_string())
}

fn open_in_browser(target: &str) {
    if let Some(url) = NSURL::URLWithString(&NSString::from_str(target)) {
        NSWorkspace::sharedWorkspace().openURL(&url);
    }
}

type Open = (Retained<NSWindow>, Retained<WKWebView>, Retained<CallDelegate>);

thread_local! {
    static OPEN: RefCell<Vec<Open>> = RefCell::default();
}

/// The call at `url` in a window titled `title`; `allowed(address, url)` says
/// where it may go and which origin gets the camera and the microphone.
pub fn call_window(url: &str, title: &str, allowed: Allowed) -> Result<(), String> {
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
    let web = unsafe {
        let configuration = WKWebViewConfiguration::new(mtm);
        WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &configuration)
    };
    let delegate = CallDelegate::new(mtm, url, allowed);
    // SAFETY: the delegate outlives the view: both are kept in OPEN.
    unsafe {
        web.setUIDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        web.setNavigationDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        web.loadRequest(&NSURLRequest::requestWithURL(&address));
    }
    window.setContentView(Some(&web));
    window.center();
    window.makeKeyAndOrderFront(None);
    OPEN.with_borrow_mut(|open| open.push((window, web, delegate)));
    call_event("window", "open");
    Ok(())
}
