//! The icon a server shows on the rail instead of the app's, read
//! without signing in for every account the rail lists: Rocket.Chat's
//! `favicon_192` asset when an administrator set one (its default logo is
//! not the server's own), Vibez's instance icon (`Discovery.icon_revision`).
//! Any other account, or a server without an icon of its own, shows its
//! provider's mark (`fallback`); a Vibez server without one, the app's.
//! Read afresh on each rail rebuild: Rocket.Chat serves the asset at a fixed
//! URL with no ETag.

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
    /// The server has no icon of its own: show `fallback`.
    Absent,
    /// Nothing to conclude (unreachable, refused, not an image): keep what is shown.
    Unknown,
}

/// The service an account belongs to, as the rail's fallback mark names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    RocketChat,
    Vibez,
    Mattermost,
    Kchat,
    Slack,
    Teams,
    WhatsApp,
}

pub fn provider(info: &SessionInfo) -> Provider {
    if crate::whatsapp::is_whatsapp(info) {
        Provider::WhatsApp
    } else if info.teams.is_some() {
        Provider::Teams
    } else if info.slack.is_some() {
        Provider::Slack
    } else if let Some(flavor) = info.mattermost {
        match flavor {
            crate::mattermost::Flavor::Mattermost => Provider::Mattermost,
            crate::mattermost::Flavor::Kchat => Provider::Kchat,
        }
    } else if info.native.is_some() {
        Provider::Vibez
    } else {
        Provider::RocketChat
    }
}

/// The provider's mark (a PNG tile, `scripts/brand-tiles/NOTICE.md`) shown
/// while the server's own icon is unknown, absent or unreadable; a Vibez
/// server falls back to the app's icon.
pub fn fallback(info: &SessionInfo) -> Option<&'static [u8]> {
    Some(match provider(info) {
        Provider::Vibez => return None,
        Provider::RocketChat => include_bytes!("../assets/brands/rocketchat.png"),
        Provider::Mattermost => include_bytes!("../assets/brands/mattermost.png"),
        Provider::Kchat => include_bytes!("../assets/brands/kchat.png"),
        Provider::Slack => include_bytes!("../assets/brands/slack.png"),
        Provider::Teams => include_bytes!("../assets/brands/teams.png"),
        Provider::WhatsApp => include_bytes!("../assets/brands/whatsapp.png"),
    })
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
    if info.mattermost.is_some() || info.slack.is_some() || info.teams.is_some() || crate::whatsapp::is_whatsapp(info) {
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
    fn every_provider_but_vibez_falls_back_to_its_own_mark() {
        let rocket_chat = SessionInfo {
            base_url: "https://chat.example.com".into(),
            user_id: "u".into(),
            username: "me".into(),
            auth_token: "t".into(),
            native: None,
            mattermost: None,
            slack: None,
            teams: None,
        };
        let kchat = SessionInfo { mattermost: Some(crate::mattermost::Flavor::Kchat), ..rocket_chat.clone() };
        let mattermost = SessionInfo { mattermost: Some(crate::mattermost::Flavor::Mattermost), ..rocket_chat.clone() };
        let teams = SessionInfo {
            teams: Some(crate::teams::auth::TeamsAccount { tenant_id: "t".into(), refresh: "r".to_owned().into() }),
            ..rocket_chat.clone()
        };
        let slack = SessionInfo {
            slack: Some(crate::slack::SlackAccount { team_id: "T1".into(), cookie: "d".to_owned().into() }),
            ..rocket_chat.clone()
        };
        let vibez = SessionInfo {
            native: Some(crate::native::Identity { instance_id: "i".into(), data_epoch: "e".into() }),
            ..rocket_chat.clone()
        };
        let whatsapp = crate::whatsapp::account_info("abc123", "33600000000@s.whatsapp.net", "Me");
        let cases = [
            (&rocket_chat, Provider::RocketChat),
            (&kchat, Provider::Kchat),
            (&mattermost, Provider::Mattermost),
            (&teams, Provider::Teams),
            (&slack, Provider::Slack),
            (&vibez, Provider::Vibez),
            (&whatsapp, Provider::WhatsApp),
        ];
        for (info, expected) in cases {
            assert_eq!(provider(info), expected);
            match fallback(info) {
                Some(bytes) => assert!(is_png_or_jpeg(bytes) && expected != Provider::Vibez, "{expected:?}"),
                None => assert_eq!(expected, Provider::Vibez),
            }
        }
        let marks: std::collections::HashSet<_> = cases.iter().filter_map(|(info, _)| fallback(info)).collect();
        assert_eq!(marks.len(), 6, "each provider has its own mark");
    }

    #[test]
    fn only_png_and_jpeg_bytes_are_images() {
        assert!(is_png_or_jpeg(b"\x89PNG\r\n\x1a\nrest"));
        assert!(is_png_or_jpeg(&[0xFF, 0xD8, 0xFF, 0xE0]));
        assert!(!is_png_or_jpeg(b"<svg xmlns"));
        assert!(!is_png_or_jpeg(b"GIF89a"));
    }
}
