//! Sessions live in the system keychain, never on disk: the Secret Service
//! (KWallet, GNOME Keyring) on Linux, the Credential Manager on Windows, the
//! Keychain on macOS. One item per account, and a small file naming the active one.

use std::time::Duration;

use gtk::glib;
use rv_core::session::SessionInfo;
use serde_json::{Value, json};

/// A keyring that never answers (no D-Bus session, a prompt left open) must
/// not leave the app on its splash screen forever.
const TIMEOUT: Duration = Duration::from_secs(5);

/// Where the keychain keeps our items: the app's first id, kept when the id
/// changed so that signed-in sessions survive it.
const KEYCHAIN_SERVICE: &str = "me.barrut.RocketVibe";

pub fn account_key(info: &SessionInfo) -> String {
    format!("{}|{}", info.base_url, info.user_id)
}

fn active_file() -> std::path::PathBuf {
    glib::user_config_dir().join("rocket-vibe-rs").join("active-account")
}

pub fn active() -> Option<String> {
    std::fs::read_to_string(active_file()).ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
}

pub fn set_active(info: &SessionInfo) {
    let file = active_file();
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(file, account_key(info));
}

fn parse(secret: &[u8]) -> Option<SessionInfo> {
    let v: Value = serde_json::from_slice(secret).ok()?;
    let field = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    let info = SessionInfo {
        base_url: field("baseUrl"),
        user_id: field("userId"),
        username: field("username"),
        auth_token: field("authToken"),
    };
    (!info.base_url.is_empty() && !info.auth_token.is_empty() && !info.user_id.is_empty()).then_some(info)
}

/// Every account signed in on this machine, the active one first.
pub async fn load_all() -> Vec<SessionInfo> {
    let mut found: Vec<SessionInfo> = Vec::new();
    match tokio::time::timeout(TIMEOUT, keychain::all()).await {
        Ok(secrets) => {
            for info in secrets.iter().filter_map(|s| parse(s)) {
                if !found.iter().any(|f| account_key(f) == account_key(&info)) {
                    found.push(info);
                }
            }
        }
        Err(_) => eprintln!("Keychain did not answer, starting signed out."),
    }
    if let Some(active) = active() {
        found.sort_by_key(|info| account_key(info) != active);
    }
    found
}

pub async fn save(info: &SessionInfo) {
    let secret = json!({
        "baseUrl": info.base_url,
        "userId": info.user_id,
        "username": info.username,
        "authToken": info.auth_token,
    })
    .to_string();
    match tokio::time::timeout(TIMEOUT, keychain::put(&account_key(info), secret.into_bytes())).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => eprintln!("Keychain write failed: {e}"),
        Err(_) => eprintln!("Keychain write timed out."),
    }
}

pub async fn remove(info: &SessionInfo) {
    let _ = tokio::time::timeout(TIMEOUT, keychain::delete(&account_key(info))).await;
}

#[cfg(target_os = "linux")]
mod keychain {
    use std::collections::HashMap;

    fn attributes() -> HashMap<&'static str, &'static str> {
        HashMap::from([("application", super::KEYCHAIN_SERVICE), ("kind", "session")])
    }

    pub async fn all() -> Vec<Vec<u8>> {
        let Ok(keyring) = oo7::Keyring::new().await else { return Vec::new() };
        let Ok(items) = keyring.search_items(&attributes()).await else { return Vec::new() };
        let mut secrets = Vec::new();
        for item in items {
            if let Ok(secret) = item.secret().await {
                secrets.push(secret.to_vec());
            }
        }
        secrets
    }

    pub async fn put(key: &str, secret: Vec<u8>) -> Result<(), String> {
        let keyring = oo7::Keyring::new().await.map_err(|e| e.to_string())?;
        // Items from before accounts had a key of their own: replaced by keyed ones.
        for item in keyring.search_items(&attributes()).await.map_err(|e| e.to_string())? {
            if item.attributes().await.is_ok_and(|a| !a.contains_key("account")) {
                let _ = item.delete().await;
            }
        }
        let mut attributes = attributes();
        attributes.insert("account", key);
        keyring.create_item("rocket-vibe session", &attributes, &secret, true).await.map_err(|e| e.to_string())
    }

    pub async fn delete(key: &str) {
        let Ok(keyring) = oo7::Keyring::new().await else { return };
        let mut attributes = attributes();
        attributes.insert("account", key);
        let _ = keyring.delete(&attributes).await;
    }
}

/// The system keychain cannot list its entries: a file keeps their keys
/// (server and user id, nothing secret).
#[cfg(not(target_os = "linux"))]
mod keychain {
    fn index_file() -> std::path::PathBuf {
        gtk::glib::user_config_dir().join("rocket-vibe-rs").join("accounts")
    }

    fn keys() -> Vec<String> {
        std::fs::read_to_string(index_file())
            .map(|s| s.lines().filter(|l| !l.is_empty()).map(str::to_owned).collect())
            .unwrap_or_default()
    }

    fn write_keys(keys: &[String]) {
        let file = index_file();
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, keys.join("\n"));
    }

    fn entry(key: &str) -> keyring::Result<keyring::Entry> {
        keyring::Entry::new(super::KEYCHAIN_SERVICE, key)
    }

    pub async fn all() -> Vec<Vec<u8>> {
        tokio::task::spawn_blocking(|| {
            keys().iter().filter_map(|k| entry(k).ok()?.get_password().ok()).map(String::into_bytes).collect()
        })
        .await
        .unwrap_or_default()
    }

    pub async fn put(key: &str, secret: Vec<u8>) -> Result<(), String> {
        let key = key.to_owned();
        tokio::task::spawn_blocking(move || {
            let secret = String::from_utf8(secret).map_err(|e| e.to_string())?;
            entry(&key).and_then(|e| e.set_password(&secret)).map_err(|e| e.to_string())?;
            let mut all = keys();
            if !all.contains(&key) {
                all.push(key);
                write_keys(&all);
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn delete(key: &str) {
        let key = key.to_owned();
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(e) = entry(&key) {
                let _ = e.delete_credential();
            }
            let mut all = keys();
            all.retain(|k| *k != key);
            write_keys(&all);
        })
        .await;
    }
}

fn servers_file() -> std::path::PathBuf {
    glib::user_config_dir().join("rocket-vibe-rs").join("servers")
}

/// Servers signed in to before, most recent first.
pub fn known_servers() -> Vec<String> {
    std::fs::read_to_string(servers_file())
        .map(|s| s.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect())
        .unwrap_or_default()
}

pub fn remember_server(base_url: &str) {
    let mut servers = known_servers();
    servers.retain(|s| s != base_url);
    servers.insert(0, base_url.to_owned());
    servers.truncate(8);
    let file = servers_file();
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(file, servers.join("\n"));
}
