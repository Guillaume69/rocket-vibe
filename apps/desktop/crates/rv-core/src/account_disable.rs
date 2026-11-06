//! Disabled accounts, from the desktop server rail's menu (user decision,
//! 2026-11-06): the account keeps its rail tile (dimmed, after the enabled
//! ones), its keyring entry and its stored messages, but is not connected: no
//! session, no background sync, notification, ring or presence. Enabling it
//! again needs no credentials. Kept in `<config>/disabled-accounts`, one
//! account key per line, shared by GTK and SwiftUI.

use std::collections::HashSet;
use std::path::Path;

use crate::session::SessionInfo;

const FILE: &str = "disabled-accounts";

/// The disabled account keys (`server_rail::key`).
pub fn disabled(config: &Path) -> HashSet<String> {
    std::fs::read_to_string(config.join(FILE))
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

pub fn is_disabled(config: &Path, key: &str) -> bool {
    disabled(config).contains(key)
}

/// Disables or enables the account; a key that would write another line is ignored.
pub fn set(config: &Path, key: &str, disable: bool) {
    if key.is_empty() || key.contains(['\n', '\r']) {
        return;
    }
    let mut keys = disabled(config);
    let changed = if disable { keys.insert(key.to_owned()) } else { keys.remove(key) };
    if !changed || std::fs::create_dir_all(config).is_err() {
        return;
    }
    let mut lines: Vec<String> = keys.into_iter().collect();
    lines.sort();
    let _ = std::fs::write(config.join(FILE), lines.join("\n"));
}

/// Forgets the accounts no longer signed in.
pub fn retain(config: &Path, accounts: &[SessionInfo]) {
    let keys = disabled(config);
    let kept: Vec<&String> =
        keys.iter().filter(|k| accounts.iter().any(|info| crate::server_rail::key(info) == **k)).collect();
    if kept.len() != keys.len() {
        let mut lines: Vec<&str> = kept.into_iter().map(String::as_str).collect();
        lines.sort();
        let _ = std::fs::write(config.join(FILE), lines.join("\n"));
    }
}

/// The disabled accounts after the enabled ones, each group in its order.
pub fn last(accounts: &mut [SessionInfo], disabled: &HashSet<String>) {
    accounts.sort_by_key(|info| disabled.contains(&crate::server_rail::key(info)));
}

/// The enabled accounts, the ones to keep connected.
pub fn enabled(accounts: &[SessionInfo], disabled: &HashSet<String>) -> Vec<SessionInfo> {
    accounts.iter().filter(|info| !disabled.contains(&crate::server_rail::key(info))).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("rv-disable-{name}-{:x}", fastrand::u64(..)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn account(base: &str, user: &str) -> SessionInfo {
        SessionInfo {
            base_url: base.to_owned(),
            user_id: user.to_owned(),
            username: user.to_owned(),
            auth_token: String::new(),
            native: None,
            mattermost: None,
            slack: None,
            teams: None,
        }
    }

    #[test]
    fn a_disabled_account_stays_until_enabled_or_signed_out() {
        let config = dir("hold");
        let (a, b) = (account("https://a", "u1"), account("https://b", "u2"));
        let key_a = crate::server_rail::key(&a);
        set(&config, &key_a, true);
        assert!(is_disabled(&config, &key_a));
        assert!(!is_disabled(&config, &crate::server_rail::key(&b)));
        set(&config, &key_a, false);
        assert!(disabled(&config).is_empty());
        set(&config, &key_a, true);
        retain(&config, std::slice::from_ref(&b));
        assert!(disabled(&config).is_empty());
        let _ = std::fs::remove_dir_all(config);
    }

    #[test]
    fn disabled_accounts_go_last_and_are_not_connected() {
        let mut accounts = vec![account("https://a", "u1"), account("https://b", "u2"), account("https://c", "u3")];
        let off: HashSet<String> = [crate::server_rail::key(&accounts[0])].into_iter().collect();
        last(&mut accounts, &off);
        let order: Vec<&str> = accounts.iter().map(|a| a.base_url.as_str()).collect();
        assert_eq!(order, ["https://b", "https://c", "https://a"]);
        let on: Vec<String> = enabled(&accounts, &off).iter().map(|a| a.base_url.clone()).collect();
        assert_eq!(on, ["https://b", "https://c"]);
    }

    #[test]
    fn a_key_never_writes_another_line() {
        let config = dir("inject");
        set(&config, "https://evil|x\nhttps://other|u9", true);
        assert!(disabled(&config).is_empty());
        let _ = std::fs::remove_dir_all(config);
    }
}
