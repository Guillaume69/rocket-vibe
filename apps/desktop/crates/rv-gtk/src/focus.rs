//! A text field unrealized while focused never tells its input method the
//! focus left; on Windows the IME then keeps a message filter on a freed
//! context. The focus moves off first, and comes back once it is shown again.

#![allow(unsafe_code)]

use gtk::glib;
use gtk::glib::translate::IntoGlib;
use gtk::prelude::*;

fn release(widget: &gtk::Widget) {
    if !(widget.is::<gtk::Text>() || widget.is::<gtk::TextView>()) || !widget.has_focus() {
        return;
    }
    let Some(root) = widget.root() else { return };
    root.set_focus(None::<&gtk::Widget>);
    let weak = widget.downgrade();
    glib::idle_add_local_once(move || {
        if let Some(widget) = weak.upgrade().filter(|w| w.is_mapped()) {
            widget.grab_focus();
        }
    });
}

unsafe extern "C" fn before_unrealize(
    _hint: *mut glib::gobject_ffi::GSignalInvocationHint,
    n_params: u32,
    params: *const glib::gobject_ffi::GValue,
    _data: glib::ffi::gpointer,
) -> glib::ffi::gboolean {
    if n_params > 0 && !params.is_null() {
        // SAFETY: GLib hands the emission's parameters, the instance first.
        let instance = unsafe { &*(params as *const glib::Value) };
        if let Ok(widget) = instance.get::<gtk::Widget>() {
            release(&widget);
        }
    }
    glib::ffi::GTRUE
}

pub fn install() {
    let Some(signal) = glib::subclass::signal::SignalId::lookup("unrealize", gtk::Widget::static_type()) else {
        return;
    };
    // SAFETY: the hook is a plain function with no data, kept for the whole run.
    unsafe {
        glib::gobject_ffi::g_signal_add_emission_hook(
            signal.into_glib(),
            0,
            Some(before_unrealize),
            std::ptr::null_mut(),
            None,
        );
    }
}
