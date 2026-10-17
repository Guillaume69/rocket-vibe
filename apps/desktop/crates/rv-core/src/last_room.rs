//! The room last opened on each account (`server_rail::key`), in a file of the
//! config dir GTK and SwiftUI share: switching back to an account reopens it.

use std::collections::BTreeMap;
use std::path::Path;

pub use crate::collapsed_sections::account;
use crate::collapsed_sections::{read_map, write_map};

const FILE: &str = "last-rooms.json";

type Saved = BTreeMap<String, String>;

fn read(config: &Path) -> Saved {
    read_map(config, FILE)
}

fn write(config: &Path, saved: &Saved) {
    write_map(config, FILE, saved);
}

pub fn load(config: &Path, account: &str) -> Option<String> {
    read(config).remove(account)
}

pub fn save(config: &Path, account: &str, rid: &str) {
    let mut saved = read(config);
    if saved.get(account).map(String::as_str) == Some(rid) {
        return;
    }
    saved.insert(account.to_owned(), rid.to_owned());
    write(config, &saved);
}

/// Drops the accounts no longer signed in on this machine. An empty list (the
/// keychain did not answer) changes nothing.
pub fn sync(config: &Path, accounts: &[String]) {
    if accounts.is_empty() {
        return;
    }
    let before = read(config);
    let mut saved = before.clone();
    saved.retain(|k, _| accounts.contains(k));
    if saved != before {
        write(config, &saved);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_account_keeps_its_own_room() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path(), "a|1"), None);
        save(dir.path(), "a|1", "general");
        save(dir.path(), "b|2", "random");
        save(dir.path(), "a|1", "dev");
        assert_eq!(load(dir.path(), "a|1").as_deref(), Some("dev"));
        assert_eq!(load(dir.path(), "b|2").as_deref(), Some("random"));
    }

    #[test]
    fn a_removed_account_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "a|1", "general");
        save(dir.path(), "b|2", "random");
        sync(dir.path(), &[]);
        assert_eq!(load(dir.path(), "a|1").as_deref(), Some("general"));
        sync(dir.path(), &["b|2".into()]);
        assert_eq!(load(dir.path(), "a|1"), None);
        assert_eq!(load(dir.path(), "b|2").as_deref(), Some("random"));
    }

    #[test]
    fn a_damaged_file_holds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), "{not json").unwrap();
        assert_eq!(load(dir.path(), "a|1"), None);
        save(dir.path(), "a|1", "general");
        assert_eq!(load(dir.path(), "a|1").as_deref(), Some("general"));
    }
}
