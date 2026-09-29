//! UNUserNotificationCenter and the dock badge. The notification center only
//! exists for a bundled app (it throws otherwise): outside `rocket-vibe.app`,
//! as in a development run, nothing is set up and `available` says so.
#![allow(unsafe_code)]

use std::sync::OnceLock;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{AnyThread, MainThreadMarker, define_class, msg_send};
use objc2_app_kit::NSApplication;
use objc2_foundation::{NSArray, NSBundle, NSError, NSSet, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction,
    UNNotificationActionOptions, UNNotificationCategory, UNNotificationCategoryOptions,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse, UNTextInputNotificationAction,
    UNTextInputNotificationResponse, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};

use crate::{Event, Handler, Toast, decode, encode, tag};

const REPLY_CATEGORY: &str = "message";
const REPLY_ACTION: &str = "reply";

static HANDLER: OnceLock<Handler> = OnceLock::new();

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "RvNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            handler.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            handler: &block2::DynBlock<dyn Fn()>,
        ) {
            respond(response);
            handler.call(());
        }
    }
);

impl Delegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        // SAFETY: NSObject's init on a freshly allocated instance.
        unsafe { msg_send![super(this), init] }
    }
}

fn respond(response: &UNNotificationResponse) {
    let Some(handler) = HANDLER.get() else { return };
    let content = response.notification().request().content();
    let Some((room, message)) = content.targetContentIdentifier().and_then(|id| decode(&id.to_string())) else {
        return;
    };
    let reply = (response.actionIdentifier().to_string() == REPLY_ACTION)
        .then(|| response.downcast_ref::<UNTextInputNotificationResponse>().map(|r| r.userText().to_string()))
        .flatten()
        .filter(|text| !text.trim().is_empty());
    handler(match reply {
        Some(text) => Event::Reply { room, message, text },
        None => Event::Open { room, message },
    });
}

fn bundled() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/// Asks for the right to notify (once; the system remembers the answer), and
/// declares the reply action.
pub fn init(_app_id: &str, _display_name: &str, handler: Handler) {
    if !bundled() || HANDLER.set(handler).is_err() {
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let delegate = Delegate::new();
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center keeps its delegate weakly; this one lives as long as the app.
    std::mem::forget(delegate);
    let options = UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge;
    center.requestAuthorizationWithOptions_completionHandler(options, &RcBlock::new(|_: Bool, _: *mut NSError| {}));
}

/// Declares the reply field once its labels are known (the app's language).
fn reply_category(center: &UNUserNotificationCenter, placeholder: &str, send: &str) {
    let action =
        UNTextInputNotificationAction::actionWithIdentifier_title_options_textInputButtonTitle_textInputPlaceholder(
            &NSString::from_str(REPLY_ACTION),
            &NSString::from_str(send),
            UNNotificationActionOptions::empty(),
            &NSString::from_str(send),
            &NSString::from_str(placeholder),
        );
    let actions: Retained<NSArray<UNNotificationAction>> =
        NSArray::from_retained_slice(&[Retained::into_super(action)]);
    let category = UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
        &NSString::from_str(REPLY_CATEGORY),
        &actions,
        &NSArray::new(),
        UNNotificationCategoryOptions::empty(),
    );
    center.setNotificationCategories(&NSSet::from_retained_slice(&[category]));
}

pub fn available() -> bool {
    HANDLER.get().is_some()
}

pub fn show(toast: &Toast) {
    if !available() {
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(toast.title));
    content.setBody(&NSString::from_str(toast.body));
    content.setThreadIdentifier(&NSString::from_str(toast.room));
    content.setTargetContentIdentifier(Some(&NSString::from_str(&encode(toast.room, toast.message))));
    if let Some(labels) = &toast.reply {
        reply_category(&center, labels.placeholder, labels.send);
        content.setCategoryIdentifier(&NSString::from_str(REPLY_CATEGORY));
    }
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(&tag(toast.room)),
        &content,
        None,
    );
    center.addNotificationRequest_withCompletionHandler(&request, None);
}

pub fn withdraw(room: &str) {
    if !available() {
        return;
    }
    let ids = NSArray::from_retained_slice(&[NSString::from_str(&tag(room))]);
    UNUserNotificationCenter::currentNotificationCenter().removeDeliveredNotificationsWithIdentifiers(&ids);
}

/// On the main thread only (AppKit); a call from elsewhere is dropped.
pub fn badge(count: i64) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let label = (count > 0).then(|| NSString::from_str(&count.min(99).to_string()));
    let tile = NSApplication::sharedApplication(mtm).dockTile();
    tile.setBadgeLabel(label.as_deref());
    tile.display();
}

/// Delivered notifications are only known asynchronously on macOS.
pub fn delivered() -> Option<usize> {
    None
}

/// The dock tile belongs to the app, not to a window.
pub fn set_window(_hwnd: isize) {}
