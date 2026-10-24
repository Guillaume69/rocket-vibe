//! The Android face of the engine: `librv_whatsapp.so`, which the app's Kotlin
//! loads through JNA (`apps/mobile/modules/whatsapp`). An engine is a positive
//! handle; its frames reach Kotlin through the callback given at open, from
//! the engine's threads, one frame at a time. Never pass a QR payload, a key
//! or a message body to a log.

use std::collections::BTreeMap;
use std::ffi::{CStr, CString, c_char, c_int};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rv_whatsapp_engine::{Device, OpenError, Sink};

/// Where frames go: Kotlin's callback, with the engine's handle.
pub type FrameCallback = extern "C" fn(handle: i64, frame: *const c_char);

struct Callback {
    handle: i64,
    callback: FrameCallback,
}

impl Sink for Callback {
    fn frame(&self, frame: String) {
        if let Ok(text) = CString::new(frame) {
            (self.callback)(self.handle, text.as_ptr());
        }
    }
}

struct Engines {
    next: i64,
    devices: BTreeMap<i64, Arc<Device>>,
}

static ENGINES: Mutex<Engines> = Mutex::new(Engines {
    next: 0,
    devices: BTreeMap::new(),
});

fn engines() -> std::sync::MutexGuard<'static, Engines> {
    ENGINES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn device(handle: i64) -> Option<Arc<Device>> {
    engines().devices.get(&handle).cloned()
}

/// A close waits for the commands still running on its engine: this many
/// checks, `CLOSE_POLL` apart (30 s).
const CLOSE_CHECKS: u32 = 1500;
const CLOSE_POLL: Duration = Duration::from_millis(20);

/// Opens the sealed state at `path` with its 32-byte key. Returns the
/// engine's handle, -1 when another engine holds the state, -2 on any other
/// failure (a wrong key, an unreadable state).
///
/// # Safety
/// `path` is a NUL-terminated string and `key` points to `key_len` bytes,
/// both valid for the call; `callback` stays callable while the engine lives.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rvwa_open(
    path: *const c_char,
    key: *const u8,
    key_len: c_int,
    callback: Option<FrameCallback>,
) -> i64 {
    let (Some(callback), false, false, 32) = (callback, path.is_null(), key.is_null(), key_len)
    else {
        return -2;
    };
    // SAFETY: the caller passes a valid NUL-terminated path and 32 readable key bytes.
    let (path, mut secret) = unsafe {
        (
            CStr::from_ptr(path).to_string_lossy().into_owned(),
            std::slice::from_raw_parts(key, 32).to_vec(),
        )
    };
    let handle = {
        let mut engines = engines();
        engines.next += 1;
        engines.next
    };
    let opened = catch_unwind(AssertUnwindSafe(|| {
        Device::open(
            Path::new(&path),
            &secret,
            Arc::new(Callback { handle, callback }),
        )
    }));
    secret.fill(0);
    match opened {
        Ok(Ok(device)) => {
            engines().devices.insert(handle, Arc::new(device));
            handle
        }
        Ok(Err(OpenError::Busy)) => -1,
        _ => -2,
    }
}

/// Reaches WhatsApp: the account's frames when linked, a QR otherwise.
#[unsafe(no_mangle)]
pub extern "C" fn rvwa_connect(handle: i64) {
    if let Some(device) = device(handle) {
        let _ = catch_unwind(AssertUnwindSafe(|| device.connect()));
    }
}

/// Runs one JSON command; 1 while the engine runs, 0 once it ended (a stop,
/// a logout) or for an unknown handle, after which only `rvwa_close` is left.
///
/// # Safety
/// `command` is a NUL-terminated string valid for the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rvwa_handle(handle: i64, command: *const c_char) -> c_int {
    let Some(device) = device(handle) else {
        return 0;
    };
    if command.is_null() {
        return 0;
    }
    // SAFETY: the caller passes a valid NUL-terminated command.
    let line = unsafe { CStr::from_ptr(command) }
        .to_string_lossy()
        .into_owned();
    match catch_unwind(AssertUnwindSafe(|| device.handle(&line))) {
        Ok(true) => 1,
        _ => 0,
    }
}

/// Checkpoints the state and releases it and its lock; the handle is gone.
/// A command still running on it is waited for, up to `CLOSE_CHECKS`; past
/// that, the engine closes when the last one returns.
#[unsafe(no_mangle)]
pub extern "C" fn rvwa_close(handle: i64) {
    let Some(mut device) = engines().devices.remove(&handle) else {
        return;
    };
    for _ in 0..CLOSE_CHECKS {
        match Arc::try_unwrap(device) {
            Ok(mut alone) => {
                let _ = catch_unwind(AssertUnwindSafe(|| alone.close()));
                return;
            }
            Err(shared) => {
                device = shared;
                std::thread::sleep(CLOSE_POLL);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    static FRAMES: Mutex<Option<mpsc::Sender<(i64, String)>>> = Mutex::new(None);

    extern "C" fn collect(handle: i64, frame: *const c_char) {
        // SAFETY: the engine passes a valid NUL-terminated frame for the call.
        let text = unsafe { CStr::from_ptr(frame) }
            .to_string_lossy()
            .into_owned();
        if let Some(sender) = FRAMES.lock().unwrap().as_ref() {
            let _ = sender.send((handle, text));
        }
    }

    #[test]
    fn an_engine_opens_answers_seals_and_refuses_a_second_open() {
        let (sender, frames) = mpsc::channel();
        *FRAMES.lock().unwrap() = Some(sender);
        let dir = std::env::temp_dir().join(format!("rvwa-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = dir.join("state");
        let path = CString::new(state.to_string_lossy().as_bytes()).unwrap();
        let key = [7u8; 32];
        // SAFETY: a valid path and 32 key bytes, for the call.
        let handle = unsafe { rvwa_open(path.as_ptr(), key.as_ptr(), 32, Some(collect)) };
        assert!(handle > 0, "an engine handle");
        // SAFETY: the same state, held by the first engine.
        assert_eq!(
            unsafe { rvwa_open(path.as_ptr(), key.as_ptr(), 32, Some(collect)) },
            -1
        );
        // SAFETY: a short key is refused before it is read.
        assert_eq!(
            unsafe { rvwa_open(path.as_ptr(), key.as_ptr(), 16, Some(collect)) },
            -2
        );
        let loaded = std::iter::from_fn(|| frames.recv_timeout(Duration::from_secs(10)).ok())
            .any(|(h, frame)| h == handle && frame.contains("\"loaded\""));
        assert!(loaded, "the engine announces its state");
        let stop = CString::new(r#"{"type":"stop"}"#).unwrap();
        // SAFETY: a valid command, for the call.
        let running = unsafe { rvwa_handle(handle, stop.as_ptr()) };
        assert!(running == 0 || running == 1);
        rvwa_close(handle);
        // SAFETY: a closed handle is unknown.
        assert_eq!(unsafe { rvwa_handle(handle, stop.as_ptr()) }, 0);
        assert!(
            std::fs::read(&state).unwrap().starts_with(b"RVWA2"),
            "a sealed state"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
