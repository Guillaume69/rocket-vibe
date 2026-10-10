//! Windows launches an unpackaged app's local COM server for toast replies,
//! including after its original process and WinRT event handler have gone.
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::sync::Arc;

use windows::Win32::Foundation::{CLASS_E_NOAGGREGATION, E_INVALIDARG, E_POINTER, RPC_E_CHANGED_MODE};
use windows::Win32::System::Com::{
    CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, CoInitializeEx, CoRegisterClassObject, CoRevokeClassObject,
    IClassFactory, IClassFactory_Impl, REGCLS_MULTIPLEUSE,
};
use windows::Win32::UI::Notifications::{
    INotificationActivationCallback, INotificationActivationCallback_Impl, NOTIFICATION_USER_INPUT_DATA,
};
use windows::core::{BOOL, GUID, IUnknown, Interface, PCWSTR, Ref, Result, implement};

use crate::windows_impl::set_value;
use crate::{Event, activation};

// Also declared in data/windows/rocket-vibe.iss; stable across app updates.
const ACTIVATOR: GUID = GUID::from_u128(0x83b10f7c_b85b_4a2a_a67e_0c8dc7d71c53);
const ACTIVATOR_NAME: &str = "{83B10F7C-B85B-4A2A-A67E-0C8DC7D71C53}";

struct Activation {
    app_id: String,
    handler: Arc<dyn Fn(Event) + Send + Sync>,
}

#[implement(INotificationActivationCallback)]
struct Callback(Arc<Activation>);

// The ABI guarantees valid NUL-terminated strings for this call. Bound their
// lengths and reject invalid UTF-16 before interpreting any app arguments.
unsafe fn text(value: PCWSTR, limit: usize) -> Result<String> {
    if value.is_null() {
        return Err(E_POINTER.into());
    }
    for len in 0..=limit {
        // SAFETY: a valid COM string, read only through its terminating NUL.
        if unsafe { *value.0.add(len) } == 0 {
            // SAFETY: the prefix just read consists of len UTF-16 units.
            return String::from_utf16(unsafe { std::slice::from_raw_parts(value.0, len) })
                .map_err(|_| E_INVALIDARG.into());
        }
    }
    Err(E_INVALIDARG.into())
}

impl INotificationActivationCallback_Impl for Callback_Impl {
    fn Activate(
        &self,
        app_id: &PCWSTR,
        args: &PCWSTR,
        data: *const NOTIFICATION_USER_INPUT_DATA,
        count: u32,
    ) -> Result<()> {
        if count > 16 {
            return Err(E_INVALIDARG.into());
        }
        if count != 0 && data.is_null() {
            return Err(E_POINTER.into());
        }
        // SAFETY: strings and count input entries supplied by the COM caller.
        let app_id = unsafe { text(*app_id, 128)? };
        if app_id != self.0.app_id {
            return Err(E_INVALIDARG.into());
        }
        // SAFETY: the callback's NUL-terminated invokedArgs.
        let args = unsafe { text(*args, 8192)? };
        let mut reply = None;
        for index in 0..count as usize {
            // SAFETY: data contains count entries for the duration of Activate.
            let input = unsafe { &*data.add(index) };
            // SAFETY: the input key and value are COM strings.
            let key = unsafe { text(input.Key, 128)? };
            if key != "reply" || reply.is_some() {
                return Err(E_INVALIDARG.into());
            }
            // SAFETY: the input value is a NUL-terminated COM string.
            let value = unsafe { text(input.Value, 32768)? };
            if value.len() > 32768 {
                return Err(E_INVALIDARG.into());
            }
            reply = Some(value);
        }
        let event = activation(&args, reply).ok_or_else(|| windows::core::Error::from(E_INVALIDARG))?;
        (self.0.handler)(event);
        Ok(())
    }
}

#[implement(IClassFactory)]
struct Factory(Arc<Activation>);

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(&self, outer: Ref<IUnknown>, iid: *const GUID, object: *mut *mut c_void) -> Result<()> {
        if object.is_null() {
            return Err(E_POINTER.into());
        }
        // SAFETY: a writable COM output pointer; failed requests return null.
        unsafe { *object = std::ptr::null_mut() };
        if iid.is_null() {
            return Err(E_POINTER.into());
        }
        if !outer.is_null() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let callback: INotificationActivationCallback = Callback(self.0.clone()).into();
        // SAFETY: validated interface/output pointers; QueryInterface AddRefs
        // the returned interface independently of this temporary callback.
        unsafe { callback.query(iid, object).ok() }
    }

    fn LockServer(&self, _lock: BOOL) -> Result<()> {
        // The GTK application owns the server's lifetime.
        Ok(())
    }
}

fn register_class(id: &GUID, activation: Arc<Activation>) -> Result<u32> {
    let factory: IClassFactory = Factory(activation).into();
    // SAFETY: COM initialized on this thread; it retains its own factory ref.
    unsafe { CoRegisterClassObject(id, &factory, CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE) }
}

pub(crate) fn register(app_id: &str, handler: Arc<dyn Fn(Event) + Send + Sync>) -> Result<u32> {
    // GTK's main thread dispatches Windows messages, including STA calls. An
    // already initialized MTA also permits registering our agile factory.
    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if initialized != RPC_E_CHANGED_MODE {
        initialized.ok()?;
    }
    let exe = std::env::current_exe().map_err(|_| windows::core::Error::from(E_INVALIDARG))?;
    let command = format!("\"{}\" -ToastActivated", exe.display());
    set_value(&format!("Software\\Classes\\CLSID\\{ACTIVATOR_NAME}\\LocalServer32"), "", &command)?;
    let cookie = register_class(&ACTIVATOR, Arc::new(Activation { app_id: app_id.into(), handler }))?;
    if let Err(error) =
        set_value(&format!("Software\\Classes\\AppUserModelId\\{app_id}"), "CustomActivator", ACTIVATOR_NAME)
    {
        // SAFETY: this process's registration, not yet used by any toast.
        let _ = unsafe { CoRevokeClassObject(cookie) };
        return Err(error);
    }
    Ok(cookie)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows_impl::wide;
    use std::sync::mpsc;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoCreateInstance, CoUninitialize};
    use windows::core::w;

    struct Apartment;
    impl Apartment {
        fn new() -> Self {
            // SAFETY: each test thread owns its matching initialization.
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok().unwrap();
            Self
        }
    }
    impl Drop for Apartment {
        fn drop(&mut self) {
            // SAFETY: balanced on the thread that initialized COM.
            unsafe { CoUninitialize() };
        }
    }
    struct Registration(u32);
    impl Drop for Registration {
        fn drop(&mut self) {
            // SAFETY: this test's class registration.
            unsafe { CoRevokeClassObject(self.0) }.unwrap();
        }
    }

    #[test]
    fn callback_checks_app_arguments_and_input_before_dispatch() {
        let (send, receive) = mpsc::channel();
        let callback: INotificationActivationCallback = Callback(Arc::new(Activation {
            app_id: "com.rocketvibe.app".into(),
            handler: Arc::new(move |event| send.send(event).unwrap()),
        }))
        .into();
        let input = NOTIFICATION_USER_INPUT_DATA { Key: w!("reply"), Value: w!("Une réponse 🚀") };
        // SAFETY: all strings and input arrays below are owned valid buffers.
        unsafe {
            callback.Activate(w!("com.rocketvibe.app"), w!("scope|m1"), &[input]).unwrap();
            assert_eq!(
                receive.try_recv().unwrap(),
                Event::Reply { room: "scope".into(), message: "m1".into(), text: "Une réponse 🚀".into() }
            );
            callback.Activate(w!("com.rocketvibe.app"), w!("scope|m1"), &[]).unwrap();
            assert_eq!(receive.try_recv().unwrap(), Event::Open { room: "scope".into(), message: "m1".into() });
            // A quick button carries the reply box's input too: it is ignored.
            callback.Activate(w!("com.rocketvibe.app"), w!("scope|m1|react|:+1:"), &[input]).unwrap();
            assert_eq!(
                receive.try_recv().unwrap(),
                Event::React { room: "scope".into(), message: "m1".into(), shortcode: ":+1:".into() }
            );
            callback.Activate(w!("com.rocketvibe.app"), w!("scope|m1|read"), &[]).unwrap();
            assert_eq!(receive.try_recv().unwrap(), Event::MarkRead { room: "scope".into(), message: "m1".into() });
            for (app, args, inputs) in [
                (w!("com.rocketvibe.app"), w!("scope|m1|react|+1"), vec![]),
                (w!("com.rocketvibe.app"), w!("scope|m1|read|x"), vec![]),
                (w!("other.app"), w!("scope|m1"), vec![]),
                (w!("com.rocketvibe.app"), w!("scope|"), vec![]),
                (w!("com.rocketvibe.app"), w!("scope|m1|extra"), vec![]),
                (w!("com.rocketvibe.app"), w!("scope|m1"), vec![input, input]),
                (
                    w!("com.rocketvibe.app"),
                    w!("scope|m1"),
                    vec![NOTIFICATION_USER_INPUT_DATA { Key: w!("unknown"), ..input }],
                ),
            ] {
                assert_eq!(callback.Activate(app, args, &inputs).unwrap_err().code(), E_INVALIDARG);
            }
            let invalid = [0xd800, 0];
            assert_eq!(text(PCWSTR(invalid.as_ptr()), 128).unwrap_err().code(), E_INVALIDARG);
            let large = wide(&"x".repeat(8193));
            assert_eq!(
                callback.Activate(w!("com.rocketvibe.app"), PCWSTR(large.as_ptr()), &[]).unwrap_err().code(),
                E_INVALIDARG
            );
        }
        assert!(receive.try_recv().is_err());
    }

    #[test]
    fn com_class_delivers_reply_from_a_separate_process() {
        let _apartment = Apartment::new();
        let id = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let (send, receive) = mpsc::channel();
        let _registration = Registration(
            register_class(
                &GUID::from_u128(id),
                Arc::new(Activation {
                    app_id: "com.rocketvibe.test".into(),
                    handler: Arc::new(move |event| send.send(event).unwrap()),
                }),
            )
            .unwrap(),
        );
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "windows_toast::tests::com_activation_child", "--ignored", "--nocapture"])
            .env("RV_TEST_TOAST_CLASS", format!("{id:032x}"))
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                let _ = child.wait();
                panic!("COM child did not finish");
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        assert!(status.success());
        assert_eq!(
            receive.recv_timeout(Duration::from_secs(1)).unwrap(),
            Event::Reply { room: "scope".into(), message: "m1".into(), text: "COM process reply".into() }
        );
        assert!(receive.try_recv().is_err());
    }

    #[test]
    #[ignore = "launched by the cross-process COM test"]
    fn com_activation_child() {
        let _apartment = Apartment::new();
        let id = u128::from_str_radix(&std::env::var("RV_TEST_TOAST_CLASS").unwrap(), 16).unwrap();
        // SAFETY: the parent registered this unique class and owns the server.
        let callback: INotificationActivationCallback =
            unsafe { CoCreateInstance(&GUID::from_u128(id), None, CLSCTX_LOCAL_SERVER) }.unwrap();
        // SAFETY: valid constant strings and a live stack input array.
        unsafe {
            callback.Activate(
                w!("com.rocketvibe.test"),
                w!("scope|m1"),
                &[NOTIFICATION_USER_INPUT_DATA { Key: w!("reply"), Value: w!("COM process reply") }],
            )
        }
        .unwrap();
    }
}
