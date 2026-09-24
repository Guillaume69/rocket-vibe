//! Sessions live in the Secret Service (KWallet, GNOME Keyring), never on
//! disk: one item per account, and a small file naming the active one.

use std::collections::HashMap;
use std::time::Duration;

use gtk::glib;
use rv_core::session::SessionInfo;
use serde_json::{Value, json};

/// A keyring that never answers (no D-Bus session, a prompt left open) must
/// not leave the app on its splash screen forever.
const TIMEOUT: Duration = Duration::from_secs(5);

pub fn account_key(info: &SessionInfo) -> String {
    format!("{}|{}", info.base_url, info.user_id)
}

fn attributes() -> HashMap<&'static str, &'static str> {
    HashMap::from([("application", crate::APP_ID), ("kind", "session")])
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
    let read = async {
        let keyring = oo7::Keyring::new().await.ok()?;
        let items = keyring.search_items(&attributes()).await.ok()?;
        let mut found = Vec::new();
        for item in items {
            if let Some(info) = item.secret().await.ok().and_then(|s| parse(&s))
                && !found.iter().any(|f: &SessionInfo| account_key(f) == account_key(&info))
            {
                found.push(info);
            }
        }
        Some(found)
    };
    let mut found = match tokio::time::timeout(TIMEOUT, read).await {
        Ok(found) => found.unwrap_or_default(),
        Err(_) => {
            eprintln!("Keychain did not answer, starting signed out.");
            Vec::new()
        }
    };
    if let Some(active) = active() {
        found.sort_by_key(|info| account_key(info) != active);
    }
    found
}

pub async fn save(info: &SessionInfo) {
    let key = account_key(info);
    let secret = json!({
        "baseUrl": info.base_url,
        "userId": info.user_id,
        "username": info.username,
        "authToken": info.auth_token,
    })
    .to_string();
    let write = async {
        let keyring = oo7::Keyring::new().await?;
        // Items from before accounts had a key of their own: replaced by keyed ones.
        for item in keyring.search_items(&attributes()).await? {
            if item.attributes().await.is_ok_and(|a| !a.contains_key("account")) {
                let _ = item.delete().await;
            }
        }
        let mut attributes = attributes();
        attributes.insert("account", &key);
        keyring.create_item("rocket-vibe session", &attributes, secret.as_bytes(), true).await
    };
    match tokio::time::timeout(TIMEOUT, write).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => eprintln!("Keychain write failed: {e}"),
        Err(_) => eprintln!("Keychain write timed out."),
    }
}

pub async fn remove(info: &SessionInfo) {
    let key = account_key(info);
    let delete = async {
        let keyring = oo7::Keyring::new().await?;
        let mut attributes = attributes();
        attributes.insert("account", &key);
        keyring.delete(&attributes).await
    };
    let _ = tokio::time::timeout(TIMEOUT, delete).await;
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
