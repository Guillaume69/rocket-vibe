//! A Windows GUI app starts without usable standard streams, and the C
//! runtime aborts the process (0xC0000409) on an invalid one. Standard input
//! and output go to NUL, standard error to a log file, unbuffered as standard
//! error always is: an abort flushes nothing. For the C runtime and Rust alike.
// The only unsafe code of the workspace: C runtime and Win32 calls with no
// safe wrapper in the dependencies.
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;

const STD_INPUT_HANDLE: u32 = -10i32 as u32;
const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
const STD_ERROR_HANDLE: u32 = -12i32 as u32;

unsafe extern "C" {
    fn __acrt_iob_func(index: u32) -> *mut c_void;
    fn _wfreopen(path: *const u16, mode: *const u16, stream: *mut c_void) -> *mut c_void;
    fn _fileno(stream: *mut c_void) -> i32;
    fn _get_osfhandle(fd: i32) -> isize;
    fn setvbuf(stream: *mut c_void, buffer: *mut c_void, mode: i32, size: usize) -> i32;
}

const IONBF: i32 = 0x0004;

unsafe extern "system" {
    fn SetStdHandle(which: u32, handle: *mut c_void) -> i32;
    fn GetStdHandle(which: u32) -> *mut c_void;
    fn GetFileType(handle: *mut c_void) -> u32;
}

const FILE_TYPE_UNKNOWN: u32 = 0;

fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

fn reopen(index: u32, which: u32, path: &std::ffi::OsStr, mode: &str) {
    // SAFETY: CRT calls on the process's own standard FILE objects, with
    // NUL-terminated wide strings that outlive the calls.
    unsafe {
        // Started from a shell or a link, the handles may be missing or
        // inherited without anything behind them: both read as unknown.
        if GetFileType(GetStdHandle(which)) != FILE_TYPE_UNKNOWN {
            return;
        }
        let stream = __acrt_iob_func(index);
        let mode = wide(std::ffi::OsStr::new(mode));
        if _wfreopen(wide(path).as_ptr(), mode.as_ptr(), stream).is_null() {
            return;
        }
        setvbuf(stream, std::ptr::null_mut(), IONBF, 0);
        let handle = _get_osfhandle(_fileno(stream));
        if handle != -1 {
            SetStdHandle(which, handle as *mut c_void);
        }
    }
}

pub fn std_streams() {
    let dir = gtk::glib::user_cache_dir().join("rocket-vibe-rs");
    let _ = std::fs::create_dir_all(&dir);
    reopen(0, STD_INPUT_HANDLE, std::ffi::OsStr::new("NUL"), "r");
    reopen(1, STD_OUTPUT_HANDLE, std::ffi::OsStr::new("NUL"), "w");
    reopen(2, STD_ERROR_HANDLE, dir.join("rocket-vibe.log").as_os_str(), "w");
    eprintln!("rocket-vibe {} started", env!("CARGO_PKG_VERSION"));
}
