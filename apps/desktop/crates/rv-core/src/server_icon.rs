//! The icon a server shows on the rail instead of its host's initial, read
//! without signing in for every account the rail lists: Rocket.Chat's
//! `favicon_192` asset when an administrator set one (its default logo is
//! not the server's own), RocketVibe's instance icon (`Discovery.icon_revision`).
//! Mattermost and kChat keep the initial. Read afresh on each rail rebuild:
//! Rocket.Chat serves the asset at a fixed URL with no ETag.

use std::time::Duration;

use serde_json::Value;

use crate::session::SessionInfo;

/// The Rocket.Chat asset the rail shows, and the exact side it demands
/// (`assets.setAsset` refuses any other width with `error-invalid-file-width`).
pub const RC_ASSET: &str = "favicon_192";
pub const RC_SIDE: u32 = 192;
/// The largest icon read.
const MAX_BYTES: usize = 2 * 1024 * 1024;

/// `settings.public?_id=Assets_favicon_192`: the asset's path when set
/// (`value.url`); its `defaultUrl` alone means the stock logo.
pub fn rc_icon_path(settings: &Value) -> Option<String> {
    settings
        .get("settings")?
        .as_array()?
        .iter()
        .find(|s| s.get("_id").and_then(Value::as_str) == Some("Assets_favicon_192"))?
        .pointer("/value/url")?
        .as_str()
        .filter(|u| !u.is_empty() && !u.contains("..") && !u.starts_with('/') && !u.contains("://"))
        .map(str::to_owned)
}

fn client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("rocket-vibe-desktop/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()
}

async fn image(client: &reqwest::Client, url: &str) -> Option<Vec<u8>> {
    let response = client.get(url).send().await.ok()?;
    let image = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.starts_with("image/png") || t.starts_with("image/jpeg"));
    if !response.status().is_success() || !image || response.content_length().is_some_and(|n| n as usize > MAX_BYTES) {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    (bytes.len() <= MAX_BYTES).then(|| bytes.to_vec())
}

/// The account's server icon, or None (no icon of its own, unreachable).
pub async fn fetch(info: &SessionInfo) -> Option<Vec<u8>> {
    if info.mattermost.is_some() {
        return None;
    }
    let base = info.base_url.trim_end_matches('/');
    let client = client()?;
    if info.native.is_some() {
        let discovery: Value =
            client.get(format!("{base}/.well-known/rocketvibe")).send().await.ok()?.json().await.ok()?;
        let revision = discovery.get("icon_revision")?.as_str()?;
        let revision: String = url::form_urlencoded::byte_serialize(revision.as_bytes()).collect();
        return image(&client, &format!("{base}/api/v1/instance/icon?v={revision}")).await;
    }
    let settings: Value = client
        .get(format!("{base}/api/v1/settings.public?_id=Assets_favicon_192"))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    image(&client, &format!("{base}/{}", rc_icon_path(&settings)?)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_a_set_asset_is_the_servers_own_icon() {
        let set = json!({"settings": [{"_id": "Assets_favicon_192", "value": {"url": "assets/favicon_192.png", "defaultUrl": "images/logo/android-chrome-192x192.png"}}]});
        assert_eq!(rc_icon_path(&set).as_deref(), Some("assets/favicon_192.png"));
        let stock = json!({"settings": [{"_id": "Assets_favicon_192", "value": {"defaultUrl": "images/logo/android-chrome-192x192.png"}}]});
        assert_eq!(rc_icon_path(&stock), None);
        for hostile in ["https://elsewhere.example/x.png", "/etc/x.png", "../x.png"] {
            let odd = json!({"settings": [{"_id": "Assets_favicon_192", "value": {"url": hostile}}]});
            assert_eq!(rc_icon_path(&odd), None, "{hostile}");
        }
    }
}
