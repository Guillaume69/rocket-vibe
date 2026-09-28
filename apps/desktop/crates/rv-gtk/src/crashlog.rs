//! Where the app leaves traces to send when something goes wrong: the log of
//! this run and the one before it (Windows, where there is no console), and
//! every panic with its backtrace, appended to `crash.log`.

use std::io::Write;
use std::path::PathBuf;

pub fn dir() -> PathBuf {
    let dir = gtk::glib::user_cache_dir().join("rocket-vibe-rs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// The previous run's log kept aside before this run truncates it.
#[cfg(windows)]
pub fn keep_previous(log: &std::path::Path) {
    let _ = std::fs::rename(log, log.with_extension("previous.log"));
}

pub fn install() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let thread = std::thread::current().name().unwrap_or("unnamed").to_owned();
        let entry = format!(
            "=== {} rocket-vibe {} ({} {}) thread '{thread}'\n{info}\n{backtrace}\n",
            chrono::Local::now().to_rfc3339(),
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
        );
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir().join("crash.log")) {
            let _ = file.write_all(entry.as_bytes());
        }
        default(info);
    }));
}
