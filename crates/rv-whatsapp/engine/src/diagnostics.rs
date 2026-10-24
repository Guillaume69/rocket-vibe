//! An opt-in diagnostic log for a live problem, to a file the user names.

use std::io::Write;
use std::sync::Mutex;

/// An opt-in diagnostic log for a live problem: `RV_WHATSAPP_LOG=<file>`. It
/// records connection states, event kinds and errors at information level,
/// never a message's text, a key or a QR. Off by default.
struct FileLog(Mutex<std::fs::File>);

impl log::Log for FileLog {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata())
            && let Ok(mut out) = self.0.lock()
        {
            let _ = writeln!(
                out,
                "{} [{} {}] {}",
                wacore::time::now_millis(),
                record.target(),
                record.level(),
                record.args()
            );
        }
    }

    fn flush(&self) {}
}

pub fn from_env() {
    let Some(path) = std::env::var_os("RV_WHATSAPP_LOG").filter(|p| !p.is_empty()) else {
        return;
    };
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    if let Ok(file) = options.open(path)
        && log::set_logger(Box::leak(Box::new(FileLog(Mutex::new(file))))).is_ok()
    {
        log::set_max_level(log::LevelFilter::Info);
    }
}
