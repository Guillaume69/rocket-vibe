//! The session lives in the Secret Service (KWallet, GNOME Keyring), never on disk.

use std::collections::HashMap;
use std::time::Duration;

use rv_core::session::SessionInfo;
use serde_json::{Value, json};

/// A keyring that never answers (no D-Bus session, a prompt left open) must
/// not leave the app on its splash screen forever.
const TIMEOUT: Duration = Duration::from_secs(5);

fn attributes() -> HashMap<&'static str, &'static str> {
    HashMap::from([("application", crate::APP_ID), ("kind", "session")])
}

pub async fn load() -> Option<SessionInfo> {
    let read = async {
        let keyring = oo7::Keyring::new().await.ok()?;
        let items = keyring.search_items(&attributes()).await.ok()?;
        let secret = items.first()?.secret().await.ok()?;
        let v: Value = serde_json::from_slice(&secret).ok()?;
        let field = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
        let info = SessionInfo {
            base_url: field("baseUrl"),
            user_id: field("userId"),
            username: field("username"),
            auth_token: field("authToken"),
        };
        (!info.base_url.is_empty() && !info.auth_token.is_empty() && !info.user_id.is_empty()).then_some(info)
    };
    match tokio::time::timeout(TIMEOUT, read).await {
        Ok(info) => info,
        Err(_) => {
            eprintln!("Keychain did not answer, starting signed out.");
            None
        }
    }
}

pub async fn save(info: &SessionInfo) {
    let secret = json!({
        "baseUrl": info.base_url,
        "userId": info.user_id,
        "username": info.username,
        "authToken": info.auth_token,
    })
    .to_string();
    let write = async {
        let keyring = oo7::Keyring::new().await?;
        keyring.create_item("rocket-vibe session", &attributes(), secret.as_bytes(), true).await
    };
    match tokio::time::timeout(TIMEOUT, write).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => eprintln!("Keychain write failed: {e}"),
        Err(_) => eprintln!("Keychain write timed out."),
    }
}

pub async fn clear() {
    let delete = async {
        let keyring = oo7::Keyring::new().await?;
        keyring.delete(&attributes()).await
    };
    let _ = tokio::time::timeout(TIMEOUT, delete).await;
}
