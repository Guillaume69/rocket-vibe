//! The room list's folded sections, per account (`server_rail::key`), in a
//! file of the config dir GTK and SwiftUI share. Before it, one list served
//! every account: each account starts from it once.

use std::collections::BTreeMap;
use std::path::Path;

use crate::session::SessionInfo;

const FILE: &str = "collapsed-sections.json";
const LEGACY: &str = "collapsed-sections";

type Saved = BTreeMap<String, Vec<String>>;

pub fn account(info: &SessionInfo) -> String {
    crate::server_rail::key(info)
}

pub(crate) fn read_map<T: serde::de::DeserializeOwned>(config: &Path, file: &str) -> BTreeMap<String, T> {
    std::fs::read_to_string(config.join(file))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub(crate) fn write_map<T: serde::Serialize>(config: &Path, file: &str, saved: &BTreeMap<String, T>) {
    if std::fs::create_dir_all(config).is_ok()
        && let Ok(text) = serde_json::to_string_pretty(saved)
    {
        let _ = std::fs::write(config.join(file), text);
    }
}

fn read(config: &Path) -> Saved {
    read_map(config, FILE)
}

fn write(config: &Path, saved: &Saved) {
    write_map(config, FILE, saved);
}

fn legacy(config: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(config.join(LEGACY)).ok()?;
    Some(text.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect())
}

/// The account's folded section keys (`Section::key`).
pub fn load(config: &Path, account: &str) -> Vec<String> {
    read(config).remove(account).or_else(|| legacy(config)).unwrap_or_default()
}

/// Folds or unfolds `section` for the account; returns its folded keys.
pub fn toggle(config: &Path, account: &str, section: &str) -> Vec<String> {
    let mut saved = read(config);
    let mut keys = saved.remove(account).or_else(|| legacy(config)).unwrap_or_default();
    match keys.iter().position(|k| k == section) {
        Some(at) => {
            keys.remove(at);
        }
        None => keys.push(section.to_owned()),
    }
    saved.insert(account.to_owned(), keys.clone());
    write(config, &saved);
    keys
}

/// With the accounts signed in on this machine: drops the removed ones, hands
/// the old shared list to the others, then deletes it. An empty list (the
/// keychain did not answer) changes nothing.
pub fn sync(config: &Path, accounts: &[String]) {
    if accounts.is_empty() {
        return;
    }
    let before = read(config);
    let mut saved = before.clone();
    saved.retain(|k, _| accounts.contains(k));
    let old = legacy(config);
    if let Some(old) = &old {
        for account in accounts {
            saved.entry(account.clone()).or_insert_with(|| old.clone());
        }
    }
    if saved != before {
        write(config, &saved);
    }
    if old.is_some() && read(config) == saved {
        let _ = std::fs::remove_file(config.join(LEGACY));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn each_account_folds_its_own_sections() {
        let dir = config();
        assert!(load(dir.path(), "a|1").is_empty());
        assert_eq!(toggle(dir.path(), "a|1", "channels"), ["channels"]);
        assert_eq!(toggle(dir.path(), "a|1", "direct"), ["channels", "direct"]);
        assert!(load(dir.path(), "b|2").is_empty());
        assert_eq!(toggle(dir.path(), "b|2", "direct"), ["direct"]);
        assert_eq!(toggle(dir.path(), "a|1", "channels"), ["direct"]);
        assert_eq!(load(dir.path(), "a|1"), ["direct"]);
        assert_eq!(load(dir.path(), "b|2"), ["direct"]);
        assert_eq!(toggle(dir.path(), "b|2", "direct"), Vec::<String>::new());
        assert!(load(dir.path(), "b|2").is_empty());
        assert_eq!(load(dir.path(), "a|1"), ["direct"]);
    }

    #[test]
    fn the_old_shared_list_seeds_every_account_once() {
        let dir = config();
        std::fs::write(dir.path().join(LEGACY), "channels\n\nfavorites\n").unwrap();
        assert_eq!(load(dir.path(), "a|1"), ["channels", "favorites"]);
        sync(dir.path(), &[]);
        assert!(dir.path().join(LEGACY).exists());
        sync(dir.path(), &["a|1".into(), "b|2".into()]);
        assert!(!dir.path().join(LEGACY).exists());
        assert_eq!(load(dir.path(), "a|1"), ["channels", "favorites"]);
        assert_eq!(toggle(dir.path(), "b|2", "channels"), ["favorites"]);
        assert_eq!(load(dir.path(), "a|1"), ["channels", "favorites"]);
        assert!(load(dir.path(), "c|3").is_empty());
    }

    #[test]
    fn signed_out_before_the_upgrade_still_finds_the_old_list() {
        let dir = config();
        std::fs::write(dir.path().join(LEGACY), "direct").unwrap();
        assert_eq!(toggle(dir.path(), "a|1", "channels"), ["direct", "channels"]);
        sync(dir.path(), &["a|1".into(), "b|2".into()]);
        assert_eq!(load(dir.path(), "a|1"), ["direct", "channels"]);
        assert_eq!(load(dir.path(), "b|2"), ["direct"]);
    }

    #[test]
    fn a_removed_account_leaves_nothing_behind() {
        let dir = config();
        toggle(dir.path(), "a|1", "channels");
        toggle(dir.path(), "b|2", "direct");
        sync(dir.path(), &["b|2".into()]);
        let text = std::fs::read_to_string(dir.path().join(FILE)).unwrap();
        assert!(!text.contains("a|1"));
        assert!(load(dir.path(), "a|1").is_empty());
        assert_eq!(load(dir.path(), "b|2"), ["direct"]);
    }

    #[test]
    fn a_damaged_file_holds_nothing() {
        let dir = config();
        std::fs::write(dir.path().join(FILE), "{not json").unwrap();
        assert!(load(dir.path(), "a|1").is_empty());
        assert_eq!(toggle(dir.path(), "a|1", "channels"), ["channels"]);
    }
}
