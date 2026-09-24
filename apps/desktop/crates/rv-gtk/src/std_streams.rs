//! A Windows GUI app starts without standard streams, and the C runtime
//! aborts the process (0xC0000409) on the first write to one: GLib and GTK
//! warnings at startup did exactly that. Standard error goes to a log file,
//! standard output to NUL, for the C runtime and for Rust alike.
// The only unsafe code of the workspace: C runtime and Win32 calls with no
// safe wrapper in the dependencies.
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;

const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
const STD_ERROR_HANDLE: u32 = -12i32 as u32;

unsafe extern "C" {
    fn __acrt_iob_func(index: u32) -> *mut c_void;
    fn _wfreopen(path: *const u16, mode: *const u16, stream: *mut c_void) -> *mut c_void;
    fn _fileno(stream: *mut c_void) -> i32;
    fn _get_osfhandle(fd: i32) -> isize;
}

unsafe extern "system" {
    fn SetStdHandle(which: u32, handle: *mut c_void) -> i32;
}

fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

fn reopen(index: u32, which: u32, path: &std::ffi::OsStr) {
    // SAFETY: CRT calls on the process's own standard FILE objects, with
    // NUL-terminated wide strings that outlive the calls.
    unsafe {
        let stream = __acrt_iob_func(index);
        if _fileno(stream) >= 0 {
            return;
        }
        let mode = wide(std::ffi::OsStr::new("w"));
        if _wfreopen(wide(path).as_ptr(), mode.as_ptr(), stream).is_null() {
            return;
        }
        let handle = _get_osfhandle(_fileno(stream));
        if handle != -1 {
            SetStdHandle(which, handle as *mut c_void);
        }
    }
}

pub fn ensure() {
    let dir = gtk::glib::user_cache_dir().join("rocket-vibe-rs");
    let _ = std::fs::create_dir_all(&dir);
    reopen(1, STD_OUTPUT_HANDLE, std::ffi::OsStr::new("NUL"));
    reopen(2, STD_ERROR_HANDLE, dir.join("rocket-vibe.log").as_os_str());
}
