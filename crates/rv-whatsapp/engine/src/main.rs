//! The desktop transport of the engine: JSON lines over the process's private
//! pipes. Stdout carries protocol frames only.
#![allow(clippy::print_stdout, clippy::print_stderr)]

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use base64::Engine as _;
use rv_whatsapp_engine::{Device, Sink};

const MAX_LINE: usize = 1 << 20;

/// Frames to stdout, one per line; a closed pipe ends the engine's work.
struct Stdout {
    device: OnceLock<Weak<Device>>,
}

impl Sink for Stdout {
    fn frame(&self, frame: String) {
        let mut out = std::io::stdout().lock();
        if writeln!(out, "{frame}").and_then(|()| out.flush()).is_err()
            && let Some(device) = self.device.get().and_then(Weak::upgrade)
        {
            device.cancel();
        }
    }
}

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

fn open_diagnostics() {
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

fn read_line(input: &mut impl BufRead) -> Option<String> {
    let mut line = String::new();
    let read = std::io::Read::take(&mut *input, MAX_LINE as u64)
        .read_line(&mut line)
        .ok()?;
    (read > 0).then(|| line.trim_end_matches(['\r', '\n']).to_owned())
}

fn run(state: PathBuf) -> Result<(), ()> {
    let mut input = std::io::stdin().lock();
    let init = read_line(&mut input).ok_or(())?;
    #[derive(serde::Deserialize)]
    struct Start {
        #[serde(rename = "type")]
        kind: String,
        key: String,
    }
    let start: Start = serde_json::from_str(&init).map_err(|_| ())?;
    if start.kind != "start" {
        return Err(());
    }
    let mut key = base64::engine::general_purpose::STANDARD
        .decode(start.key)
        .map_err(|_| ())?;
    let sink = Arc::new(Stdout {
        device: OnceLock::new(),
    });
    let opened = Device::open(&state, &key, Arc::clone(&sink) as Arc<dyn Sink>);
    key.fill(0);
    let device = Arc::new(opened.map_err(|e| log::info!("open failed: {e}"))?);
    let _ = sink.device.set(Arc::downgrade(&device));
    device.connect();
    while let Some(line) = read_line(&mut input) {
        if !device.handle(&line) {
            break;
        }
    }
    if let Ok(mut device) = Arc::try_unwrap(device) {
        device.close();
    }
    Ok(())
}

fn main() {
    let mut args = std::env::args().skip(1);
    let mut state = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--version" | "-version" => {
                println!(
                    "rv-whatsapp {}, whatsapp-rust 0.7.0",
                    env!("CARGO_PKG_VERSION")
                );
                return;
            }
            "--state" | "-state" => state = args.next(),
            _ => {}
        }
    }
    let Some(state) = state.filter(|s| !s.is_empty()) else {
        eprintln!("WhatsApp: missing state path");
        std::process::exit(2);
    };
    open_diagnostics();
    if run(PathBuf::from(state)).is_err() {
        // Errors from the network or the state may contain sensitive material.
        println!(r#"{{"type":"error","code":"connector_start_failed"}}"#);
        std::process::exit(1);
    }
}
