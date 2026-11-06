//! "Keep my status online", per account (user decision, 2026-11-06): a Teams
//! account connected here, open or in the background, holds my status online
//! like Teams' own clients do. On by default; the accounts that turned it off
//! are kept in `<config>/presence-not-kept`, one account key per line, shared
//! by GTK and SwiftUI.

use std::collections::BTreeSet;
use std::path::Path;

const FILE: &str = "presence-not-kept";

fn read(config: &Path) -> BTreeSet<String> {
    std::fs::read_to_string(config.join(FILE)).unwrap_or_default().lines().map(str::to_owned).collect()
}

fn write(config: &Path, keys: &BTreeSet<String>) {
    let lines: Vec<&str> = keys.iter().map(String::as_str).collect();
    if std::fs::create_dir_all(config).is_ok() {
        let _ = std::fs::write(config.join(FILE), lines.join("\n"));
    }
}

/// Whether the account holds my status online.
pub fn kept(config: &Path, key: &str) -> bool {
    !read(config).contains(key)
}

pub fn set(config: &Path, key: &str, on: bool) {
    if key.is_empty() || key.contains(['\n', '\r']) {
        return;
    }
    let mut off = read(config);
    let changed = if on { off.remove(key) } else { off.insert(key.to_owned()) };
    if changed {
        write(config, &off);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_unless_turned_off() {
        let dir = std::env::temp_dir().join(format!("rv-keep-online-{:032x}", fastrand::u128(..)));
        assert!(kept(&dir, "a"));
        set(&dir, "a", false);
        assert!(!kept(&dir, "a"));
        assert!(kept(&dir, "b"));
        set(&dir, "a", true);
        assert!(kept(&dir, "a"));
        set(&dir, "line\nbreak", false);
        assert!(kept(&dir, "line\nbreak"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
