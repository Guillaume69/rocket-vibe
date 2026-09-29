//! GLib and GTK messages, kept to a readable size: a message repeated back to
//! back is written once, then counted, and the whole output stops at a cap. A
//! GTK critical fired on every window message once filled a log with four
//! million copies of itself.

use std::io::Write;
use std::sync::Mutex;

use gtk::glib;

/// What the app writes of GLib's messages, per run.
pub const CAP: u64 = 5 * 1024 * 1024;

pub struct Limiter {
    cap: u64,
    written: u64,
    last: Option<String>,
    repeats: u64,
    stopped: bool,
}

impl Limiter {
    pub fn new(cap: u64) -> Self {
        Limiter { cap, written: 0, last: None, repeats: 0, stopped: false }
    }

    /// The lines to write for a message: `key` tells repeats apart (the text
    /// without its time), `text` is what is written.
    pub fn lines(&mut self, key: &str, text: &str) -> Vec<String> {
        if self.stopped {
            return Vec::new();
        }
        let mut out = Vec::new();
        if self.last.as_deref() == Some(key) {
            self.repeats += 1;
            if self.repeats.is_power_of_two() && self.repeats >= 8 {
                out.push(format!("(the last message repeated {} times so far)\n", self.repeats));
            }
        } else {
            if self.repeats > 0 {
                out.push(format!("(the last message repeated {} times)\n", self.repeats));
            }
            self.last = Some(key.to_owned());
            self.repeats = 0;
            out.push(format!("{text}\n"));
        }
        let size: u64 = out.iter().map(|l| l.len() as u64).sum();
        if self.written + size > self.cap {
            self.stopped = true;
            return vec![format!("(log capped at {} MB: later messages are dropped)\n", self.cap / (1024 * 1024))];
        }
        self.written += size;
        out
    }
}

static LIMITER: Mutex<Option<Limiter>> = Mutex::new(None);

fn field<'a>(fields: &'a [glib::LogField<'a>], key: &str) -> Option<&'a str> {
    fields.iter().find(|f| f.key() == key).and_then(|f| f.value_str())
}

/// GLib's own rule: debug and info only for the domains `G_MESSAGES_DEBUG` names.
fn dropped(level: glib::LogLevel, domain: Option<&str>) -> bool {
    if !matches!(level, glib::LogLevel::Debug | glib::LogLevel::Info) {
        return false;
    }
    let wanted = std::env::var("G_MESSAGES_DEBUG").unwrap_or_default();
    !wanted.split([' ', ',']).any(|d| d == "all" || Some(d) == domain)
}

/// GLib's messages go through the limiter to standard error, as GLib writes them.
pub fn install() {
    *LIMITER.lock().unwrap() = Some(Limiter::new(CAP));
    glib::log_set_writer_func(|level, fields| {
        let domain = field(fields, "GLIB_DOMAIN");
        if dropped(level, domain) {
            return glib::LogWriterOutput::Handled;
        }
        let key = format!("{}|{:?}|{}", domain.unwrap_or(""), level, field(fields, "MESSAGE").unwrap_or(""));
        let text = glib::log_writer_format_fields(level, fields, false);
        let lines = LIMITER.lock().unwrap().as_mut().map(|l| l.lines(&key, &text)).unwrap_or_default();
        let mut stderr = std::io::stderr().lock();
        for line in lines {
            let _ = stderr.write_all(line.as_bytes());
        }
        glib::LogWriterOutput::Handled
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeats_are_counted_not_written() {
        let mut l = Limiter::new(1 << 20);
        assert_eq!(l.lines("a", "A 1"), ["A 1\n"]);
        let noted: Vec<String> = (0..20).flat_map(|_| l.lines("a", "A 2")).collect();
        assert_eq!(
            noted,
            ["(the last message repeated 8 times so far)\n", "(the last message repeated 16 times so far)\n"]
        );
        assert_eq!(l.lines("b", "B"), ["(the last message repeated 20 times)\n", "B\n"]);
        assert_eq!(l.lines("a", "A 3"), ["A 3\n"]);
    }

    #[test]
    fn output_stops_at_the_cap() {
        let mut l = Limiter::new(2 * 1024 * 1024);
        let line = "x".repeat(1024 * 1024);
        assert_eq!(l.lines("1", &line).len(), 1);
        assert_eq!(l.lines("2", &line), ["(log capped at 2 MB: later messages are dropped)\n"]);
        assert!(l.lines("3", "small").is_empty());
    }
}
