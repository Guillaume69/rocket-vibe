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

/// The rail's order once `moved` is dropped on `target`: it takes the
/// target's place, so it lands after the target when it moves down and
/// before it when it moves up. None when nothing moves (the same key, or one
/// the rail does not hold).
pub fn reordered(keys: &[String], moved: &str, target: &str) -> Option<Vec<String>> {
    let from = keys.iter().position(|k| k == moved)?;
    let to = keys.iter().position(|k| k == target)?;
    if from == to {
        return None;
    }
    let mut keys = keys.to_vec();
    let key = keys.remove(from);
    keys.insert(to, key);
    Some(keys)
}

/// Saves the rail's order chosen by the user (a drag and drop): the file
/// `order` reads, shared by GTK and SwiftUI.
pub fn save(config: &Path, keys: &[String]) {
    if keys.is_empty() || std::fs::create_dir_all(config).is_err() {
        return;
    }
    let _ = std::fs::write(config.join("server-rail-order"), keys.join("\n"));
}

/// The rail position a Ctrl (Cmd on SwiftUI) + digit shortcut opens: 1 to 9
/// the first nine accounts. Ctrl + 0 resets the zoom (`zoom`).
pub fn shortcut_slot(digit: u32) -> Option<usize> {
    match digit {
        1..=9 => Some(digit as usize - 1),
        _ => None,
    }
}

/// The digit of the shortcut that opens the rail's `slot`, for its tooltip or
/// menu; None past the ninth account.
pub fn shortcut_digit(slot: usize) -> Option<u32> {
    match slot {
        0..=8 => Some(slot as u32 + 1),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    #[test]
    fn a_dropped_account_takes_the_place_of_its_target() {
        let rail = keys(&["a", "b", "c", "d"]);
        assert_eq!(reordered(&rail, "a", "c"), Some(keys(&["b", "c", "a", "d"])), "down: after the target");
        assert_eq!(reordered(&rail, "d", "b"), Some(keys(&["a", "d", "b", "c"])), "up: before the target");
        assert_eq!(reordered(&rail, "a", "b"), Some(keys(&["b", "a", "c", "d"])));
        assert_eq!(reordered(&rail, "b", "b"), None);
        assert_eq!(reordered(&rail, "x", "b"), None);
        assert_eq!(reordered(&rail, "a", "x"), None);
    }

    #[test]
    fn digits_open_the_first_nine_accounts() {
        assert_eq!((1..=9).map(shortcut_slot).collect::<Vec<_>>(), (0..9).map(Some).collect::<Vec<_>>());
        assert_eq!(shortcut_slot(0), None, "Ctrl + 0 resets the zoom");
        assert_eq!(shortcut_slot(10), None);
        for slot in 0..9 {
            assert_eq!(shortcut_digit(slot).and_then(shortcut_slot), Some(slot));
        }
        assert_eq!(shortcut_digit(9), None);
    }

    #[test]
    fn a_saved_order_is_the_one_read_next() {
        let config = std::env::temp_dir().join(format!("rv-rail-save-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&config);
        let mut accounts = vec![account("alice"), account("bob"), account("carol")];
        order(&mut accounts, &config);
        let rail: Vec<String> = accounts.iter().map(key).collect();
        save(&config, &reordered(&rail, &key(&account("carol")), &key(&account("alice"))).unwrap());
        let mut accounts = vec![account("alice"), account("bob"), account("carol")];
        order(&mut accounts, &config);
        assert_eq!(accounts.iter().map(|i| i.user_id.as_str()).collect::<Vec<_>>(), ["carol", "alice", "bob"]);
        save(&config, &[]);
        order(&mut accounts, &config);
        assert_eq!(accounts.iter().map(|i| i.user_id.as_str()).collect::<Vec<_>>(), ["carol", "alice", "bob"]);
        std::fs::remove_dir_all(config).unwrap();
    }

    fn account(user: &str) -> SessionInfo {
        SessionInfo {
            base_url: "https://chat.example.com".into(),
            user_id: user.into(),
            username: user.into(),
            auth_token: "never-persist-this-token".into(),
            native: None,
            mattermost: None,
            slack: None,
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
