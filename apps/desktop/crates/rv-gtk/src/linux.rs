//! WebKitGTK's DMA-BUF renderer paints nothing on NVIDIA's driver: the
//! sign-in windows (Slack, Teams, kChat) stayed blank. A value the user set wins.
// Unsafe code is denied elsewhere: setting the environment has no safe form.
#![allow(unsafe_code)]

pub fn webkit_renderer() {
    if std::path::Path::new("/proc/driver/nvidia/version").exists() {
        // SAFETY: called first thing in main, while the process has one thread.
        let _ = unsafe { gtk::glib::setenv("WEBKIT_DISABLE_DMABUF_RENDERER", "1", false) };
    }
}
