//! The dock's reopen, and starting at login through a launch agent. GTK's
//! application delegate leaves a click on the dock icon unanswered when the
//! window is hidden: the method is added to its class here.
#![allow(unsafe_code)]

use std::cell::RefCell;
use std::path::PathBuf;

use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{MainThreadMarker, sel};
use objc2_app_kit::NSApplication;

use crate::{AppEvent, AppHandler, LOGIN_ENTRY, TrayLabels};

thread_local! {
    static HANDLER: RefCell<Option<AppHandler>> = RefCell::default();
}

#[cfg(target_arch = "aarch64")]
const REOPEN_TYPES: &std::ffi::CStr = c"B@:@B";
#[cfg(not(target_arch = "aarch64"))]
const REOPEN_TYPES: &std::ffi::CStr = c"c@:@c";

unsafe extern "C-unwind" fn should_handle_reopen(
    _this: *mut AnyObject,
    _cmd: Sel,
    _app: *mut AnyObject,
    visible: Bool,
) -> Bool {
    if !visible.as_bool() {
        let handler = HANDLER.with_borrow(Clone::clone);
        if let Some(handler) = handler {
            handler(AppEvent::Show);
        }
    }
    Bool::YES
}

/// Where a click on the dock icon, with no window shown, is reported. Called
/// once GTK has set up the application (its delegate exists from then on).
pub fn app_events(handler: AppHandler) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    HANDLER.with_borrow_mut(|h| *h = Some(handler));
    let Some(delegate) = NSApplication::sharedApplication(mtm).delegate() else { return };
    let object: &AnyObject = delegate.as_ref();
    let class: *const AnyClass = object.class();
    let reopen: unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, Bool) -> Bool = should_handle_reopen;
    // SAFETY: the function matches the selector's signature and REOPEN_TYPES; a class that
    // already answers it keeps its own method (class_addMethod then returns NO).
    let added = unsafe {
        let imp: Imp = std::mem::transmute(reopen);
        objc2::ffi::class_addMethod(
            class as *mut AnyClass,
            sel!(applicationShouldHandleReopen:hasVisibleWindows:),
            imp,
            REOPEN_TYPES.as_ptr(),
        )
    };
    if !added.as_bool() {
        eprintln!("Dock reopen left to the application delegate");
    }
}

/// macOS launches one copy of a bundle: nothing to hand over.
pub fn claim_instance(_args: &[String]) -> bool {
    true
}

/// The dock stands in for a tray icon.
pub fn tray(_labels: Option<TrayLabels>) {}

fn bundle() -> Option<PathBuf> {
    crate::bundle_of(&std::env::current_exe().ok()?)
}

fn agent_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").filter(|h| !h.is_empty())?;
    Some(PathBuf::from(home).join("Library/LaunchAgents").join(format!("{LOGIN_ENTRY}.plist")))
}

/// Only an app bundle can be opened at login.
pub fn autostart_supported() -> bool {
    bundle().is_some()
}

pub fn autostart() -> bool {
    agent_path().is_some_and(|p| p.exists())
}

pub fn set_autostart(on: bool) -> Result<(), String> {
    let path = agent_path().ok_or("no home directory")?;
    if on {
        let bundle = bundle().ok_or("not running from an app bundle")?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, crate::launch_agent(&bundle.to_string_lossy())).map_err(|e| e.to_string())
    } else {
        match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}
