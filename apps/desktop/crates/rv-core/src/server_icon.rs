//! The icon a server shows on the rail instead of its host's initial, read
//! without signing in for every account the rail lists: Rocket.Chat's
//! `favicon_192` asset when an administrator set one (its default logo is
//! not the server's own), RocketVibe's instance icon (`Discovery.icon_revision`).
//! Mattermost and kChat keep the initial. Read afresh on each rail rebuild:
//! Rocket.Chat serves the asset at a fixed URL with no ETag.

use std::time::Duration;

use serde_json::Value;

use crate::rest::{CallOptions, RestClient};
use crate::session::SessionInfo;

/// The Rocket.Chat asset the rail shows, and the exact side it demands
/// (`assets.setAsset` refuses any other width with `error-invalid-file-width`).
pub const RC_ASSET: &str = "favicon_192";
pub const RC_SIDE: u32 = 192;
/// The largest icon read.
const MAX_BYTES: usize = 2 * 1024 * 1024;

/// What a read of a server's icon found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Icon {
    /// A PNG or JPEG of at most 2 MiB.
    Image(Vec<u8>),
    /// The server has no icon of its own: show the initial.
    Absent,
    /// Nothing to conclude (unreachable, refused, not an image): keep what is shown.
    Unknown,
}

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
        .filter(|u| !u.is_empty() && !u.contains("..") && !u.contains('%') && !u.starts_with('/') && !u.contains("://"))
        .map(str::to_owned)
}

/// PNG or JPEG by their first bytes: what reaches an image loader, whatever
/// the response's `Content-Type` claimed.
pub fn is_png_or_jpeg(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.starts_with(&[0xFF, 0xD8, 0xFF])
}

/// Reads at most `MAX_BYTES`, whatever the response announces (Rocket.Chat
/// streams files without `Content-Length`).
async fn image(url: &str) -> Icon {
    let Ok(client) = reqwest::Client::builder()
        .user_agent(concat!("rocket-vibe-desktop/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return Icon::Unknown;
    };
    let Ok(mut response) = client.get(url).send().await else { return Icon::Unknown };
    if !response.status().is_success() {
        return Icon::Unknown;
    }
    let mut bytes = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Icon::Unknown;
        }
        bytes.extend_from_slice(&chunk);
    }
    if is_png_or_jpeg(&bytes) { Icon::Image(bytes) } else { Icon::Unknown }
}

/// The account's server icon.
pub async fn fetch(info: &SessionInfo) -> Icon {
    if info.mattermost.is_some() {
        return Icon::Absent;
    }
    if info.native.is_some() {
        let Ok(client) = rv_client::NativeClient::new(&info.base_url) else { return Icon::Unknown };
        let Ok(discovery) = client.discover().await else { return Icon::Unknown };
        let Some(revision) = discovery.icon_revision else { return Icon::Absent };
        return match client.instance_icon(&revision).await {
            Ok(bytes) if is_png_or_jpeg(&bytes) => Icon::Image(bytes),
            _ => Icon::Unknown,
        };
    }
    let Ok(base) = url::Url::parse(&info.base_url) else { return Icon::Unknown };
    let settings = CallOptions { anonymous: true, ..CallOptions::params([("_id", "Assets_favicon_192")]) };
    let Ok(answer) = RestClient::new(base).get("settings.public", settings).await else { return Icon::Unknown };
    if answer.get("settings").and_then(Value::as_array).is_none() {
        return Icon::Unknown;
    }
    match rc_icon_path(&answer) {
        Some(path) => image(&format!("{}/{path}", info.base_url.trim_end_matches('/'))).await,
        None => Icon::Absent,
    }
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
        for hostile in ["https://elsewhere.example/x.png", "/etc/x.png", "../x.png", "%2e%2e/x.png"] {
            let odd = json!({"settings": [{"_id": "Assets_favicon_192", "value": {"url": hostile}}]});
            assert_eq!(rc_icon_path(&odd), None, "{hostile}");
        }
    }

    #[test]
    fn only_png_and_jpeg_bytes_are_images() {
        assert!(is_png_or_jpeg(b"\x89PNG\r\n\x1a\nrest"));
        assert!(is_png_or_jpeg(&[0xFF, 0xD8, 0xFF, 0xE0]));
        assert!(!is_png_or_jpeg(b"<svg xmlns"));
        assert!(!is_png_or_jpeg(b"GIF89a"));
    }
}
