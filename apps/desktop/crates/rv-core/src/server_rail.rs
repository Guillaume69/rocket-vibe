//! Stable account order for the desktop server rail, independent of selection.

use std::path::Path;

use crate::session::SessionInfo;

pub fn key(info: &SessionInfo) -> String {
    format!("{}|{}", info.base_url, info.user_id)
}

/// Keep the initial account order across keychain reads and restarts. New
/// accounts append; removed accounts leave the order. Only account keys are
/// persisted, never tokens. GTK and SwiftUI share this file.
pub fn order(accounts: &mut [SessionInfo], config: &Path) {
    // An unavailable keychain must not erase the previous order.
    if accounts.is_empty() {
        return;
    }
    let file = config.join("server-rail-order");
    let saved = std::fs::read_to_string(&file).unwrap_or_default();
    let mut keys: Vec<String> = saved.lines().filter(|k| !k.is_empty()).map(str::to_owned).collect();
    keys.retain(|k| accounts.iter().any(|info| key(info) == *k));
    for info in accounts.iter() {
        let k = key(info);
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    accounts.sort_by_key(|info| keys.iter().position(|k| *k == key(info)).unwrap_or(usize::MAX));
    let updated = keys.join("\n");
    if saved != updated && std::fs::create_dir_all(config).is_ok() {
        let _ = std::fs::write(file, updated);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(user: &str) -> SessionInfo {
        SessionInfo {
            base_url: "https://chat.example.com".into(),
            user_id: user.into(),
            username: user.into(),
            auth_token: "never-persist-this-token".into(),
            native: None,
            mattermost: None,
        }
    }

    #[test]
    fn selection_and_keychain_reordering_keep_positions_after_restart() {
        let config = std::env::temp_dir().join(format!("rv-rail-order-{}", std::process::id()));
        std::fs::create_dir_all(&config).unwrap();
        let file = config.join("server-rail-order");
        let _ = std::fs::remove_file(&file);
        let mut accounts = vec![account("alice"), account("bob"), account("carol")];
        order(&mut accounts, &config);
        for users in [["bob", "carol", "alice"], ["carol", "alice", "bob"]] {
            // Fresh values stand in for a new keychain read or a restart.
            let mut accounts: Vec<_> = users.into_iter().map(account).collect();
            order(&mut accounts, &config);
            assert_eq!(accounts.iter().map(|i| i.user_id.as_str()).collect::<Vec<_>>(), ["alice", "bob", "carol"]);
        }
        let before = std::fs::read_to_string(&file).unwrap();
        order(&mut [], &config);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
        let mut accounts = vec![account("dave"), account("carol"), account("alice")];
        order(&mut accounts, &config);
        assert_eq!(accounts.iter().map(|i| i.user_id.as_str()).collect::<Vec<_>>(), ["alice", "carol", "dave"]);
        let saved = std::fs::read_to_string(&file).unwrap();
        assert!(!saved.contains("never-persist-this-token"));
        assert!(!saved.contains("|bob"));
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(config).unwrap();
    }
}
