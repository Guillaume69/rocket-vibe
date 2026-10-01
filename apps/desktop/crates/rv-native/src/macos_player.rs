//! The inline video player on macOS: a WKWebView laid over the card, in a
//! view of the app window's own that cuts it to the message list, since a
//! GTK window cannot hold a native view among its widgets. The page is
//! loaded with a base address of ours, so the embed gets a Referer.

#![allow(unsafe_code)]

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_app_kit::{NSApplication, NSView, NSWindow, NSWorkspace};
use objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL};
use objc2_web_kit::{
    WKAudiovisualMediaTypes, WKNavigation, WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate,
    WKNavigationType, WKUIDelegate, WKWebView, WKWebViewConfiguration, WKWebsiteDataStore, WKWindowFeatures,
};

use crate::{Decide, Go, Rect, player_event};

pub struct Ivars {
    decide: Decide,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "RvPlayerDelegate"]
    #[ivars = Ivars]
    struct PlayerDelegate;

    unsafe impl NSObjectProtocol for PlayerDelegate {}

    unsafe impl WKUIDelegate for PlayerDelegate {
        #[unsafe(method_id(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
        fn create_window(
            &self,
            _web: &WKWebView,
            _configuration: &WKWebViewConfiguration,
            action: &WKNavigationAction,
            _features: &WKWindowFeatures,
        ) -> Option<Retained<WKWebView>> {
            if let Some(target) = target_of(action).filter(|t| t.starts_with("https://") || t.starts_with("http://")) {
                player_event("left for the browser", &target);
                open_in_browser(&target);
            }
            None
        }
    }

    unsafe impl WKNavigationDelegate for PlayerDelegate {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide(
            &self,
            _web: &WKWebView,
            action: &WKNavigationAction,
            handler: &block2::DynBlock<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            let target = target_of(action).unwrap_or_default();
            // SAFETY: plain reads of the action WebKit hands us, on the main thread.
            let (main_frame, clicked) = unsafe {
                (
                    action.targetFrame().is_none_or(|f| f.isMainFrame()),
                    action.navigationType() == WKNavigationType::LinkActivated,
                )
            };
            let go = (self.ivars().decide)(&target, main_frame, clicked);
            handler.call((if go == Go::Allow {
                WKNavigationActionPolicy::Allow
            } else {
                WKNavigationActionPolicy::Cancel
            },));
            if go != Go::Allow {
                player_event("left for the browser", &target);
            }
            if go == Go::Browser {
                open_in_browser(&target);
            }
        }

        #[unsafe(method(webView:didFinishNavigation:))]
        fn finished(&self, web: &WKWebView, _navigation: Option<&WKNavigation>) {
            // SAFETY: reading the page's address on the main thread.
            let url = unsafe { web.URL() }.and_then(|u| u.absoluteString()).map(|s| s.to_string());
            player_event("loaded", &url.unwrap_or_default());
        }
    }
);

impl PlayerDelegate {
    fn new(mtm: MainThreadMarker, decide: Decide) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars { decide });
        // SAFETY: NSObject's init on a freshly allocated instance.
        unsafe { msg_send![super(this), init] }
    }
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

/// A player on screen; dropping it takes the page away.
pub struct Player {
    window: Retained<NSWindow>,
    clip: Retained<NSView>,
    web: Retained<WKWebView>,
    _delegate: Retained<PlayerDelegate>,
}

/// A player for the page `html`, whose address is `url`, in the app's key
/// window (else its main one, else the first shown); `decide` says where it may go. Hidden until placed.
pub fn player(_window: isize, url: &str, html: &str, decide: Decide) -> Result<Player, String> {
    let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
    let app = NSApplication::sharedApplication(mtm);
    let window = app
        .keyWindow()
        .or_else(|| app.mainWindow())
        .or_else(|| app.windows().iter().find(|w| w.isVisible()))
        .ok_or("no app window")?;
    let content = window.contentView().ok_or("no content view")?;
    let base = NSURL::URLWithString(&NSString::from_str(url)).ok_or("not a URL")?;
    let zero = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
    let clip = NSView::initWithFrame(NSView::alloc(mtm), zero);
    // SAFETY: an AppKit property (macOS 14+) set on the main thread.
    let () = unsafe { msg_send![&*clip, setClipsToBounds: true] };
    clip.setHidden(true);
    // SAFETY: WebKit objects made and used on the main thread.
    let web = unsafe {
        let configuration = WKWebViewConfiguration::new(mtm);
        configuration.setMediaTypesRequiringUserActionForPlayback(WKAudiovisualMediaTypes::None);
        configuration.setWebsiteDataStore(&WKWebsiteDataStore::nonPersistentDataStore(mtm));
        WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), zero, &configuration)
    };
    let delegate = PlayerDelegate::new(mtm, decide);
    // SAFETY: the delegate outlives the view: both are kept in the Player.
    unsafe {
        web.setUIDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        web.setNavigationDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        web.loadHTMLString_baseURL(&NSString::from_str(html), Some(&base));
    }
    clip.addSubview(&web);
    content.addSubview(&clip);
    player_event("window", "made");
    Ok(Player { window, clip, web, _delegate: delegate })
}

impl Player {
    /// Lays the page over `card`, showing only what falls inside `clip`; both
    /// in the window's logical pixels, from its top-left corner.
    pub fn place(&self, card: Rect, clip: Rect, _scale: f64) {
        let (left, top) = (card.x.max(clip.x), card.y.max(clip.y));
        let (right, bottom) =
            ((card.x + card.width).min(clip.x + clip.width), (card.y + card.height).min(clip.y + clip.height));
        if right <= left || bottom <= top {
            return self.hide();
        }
        let Some(content) = self.window.contentView() else { return };
        let height = content.bounds().size.height;
        let y = if content.isFlipped() { top } else { height - bottom };
        self.clip.setFrame(NSRect::new(NSPoint::new(left, y), NSSize::new(right - left, bottom - top)));
        let web_y = if self.clip.isFlipped() { card.y - top } else { bottom - (card.y + card.height) };
        self.web.setFrame(NSRect::new(NSPoint::new(card.x - left, web_y), NSSize::new(card.width, card.height)));
        self.clip.setHidden(false);
    }

    pub fn hide(&self) {
        self.clip.setHidden(true);
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        // SAFETY: stopping the page before its view leaves the window, on the main thread.
        unsafe { self.web.stopLoading() };
        self.clip.removeFromSuperview();
        player_event("closed", "");
    }
}
