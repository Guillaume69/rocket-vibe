//! Avatars and attached files. The target server protects both
//! (`FileUpload_ProtectFiles`, `Accounts_AvatarBlockUnauthenticatedAccess`):
//! every read carries `rc_uid`/`rc_token` in the query.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;

pub use crate::rest::protected_url;
use crate::rest::{RestClient, RestError};
use crate::store::RoomRow;

/// Account-scoped disk/media keys. Tuple serialization avoids delimiter
/// collisions; credentials never appear in a path.
pub fn account_cache_key(base_url: &str, user_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let identity = serde_json::to_vec(&(base_url.trim_end_matches('/'), user_id)).unwrap();
    Sha256::digest(identity).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn attachment_cache_name(url: &str, title: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest: String = Sha256::digest(url.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    let safe: String = title.chars().map(|c| if matches!(c, '/' | '\\' | '\0') { '_' } else { c }).collect();
    let tail: String = safe.chars().rev().take(64).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{digest}-{tail}")
}

/// Beyond this, the cache is simply emptied: photos are small and refetched on demand.
const CACHE_LIMIT: usize = 400;

pub enum AvatarTarget<'a> {
    User(&'a str),
    Uid(&'a str),
    Room(&'a str),
}

pub fn avatar_path(target: AvatarTarget, etag: Option<&str>) -> String {
    let enc = encode_component;
    let mut path = match target {
        AvatarTarget::User(username) => format!("/avatar/{}", enc(username)),
        AvatarTarget::Uid(uid) => format!("/avatar/uid/{}", enc(uid)),
        AvatarTarget::Room(rid) => format!("/avatar/room/{}", enc(rid)),
    };
    if let Some(etag) = etag.filter(|e| !e.is_empty()) {
        path.push_str(&format!("?etag={}", enc(etag)));
    }
    path
}

/// `encodeURIComponent`: a username is a path segment, where `+` is literal.
fn encode_component(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// DM: the other person's photo by uid; channel or group: the room's photo.
/// A locked encrypted room keeps its grey padlock.
pub fn room_avatar_path(r: &RoomRow) -> Option<String> {
    if r.encrypted {
        return None;
    }
    match (r.kind.as_str(), &r.dm_other_uid) {
        ("d", Some(uid)) => Some(avatar_path(AvatarTarget::Uid(uid), None)),
        ("d", None) => None,
        _ => Some(avatar_path(AvatarTarget::Room(&r.rid), r.avatar_etag.as_deref())),
    }
}

/// The etag of a photo that was removed: the URL must still change, or the
/// cached old photo would be served under the old one.
pub const NO_PHOTO: &str = "none";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageAttachment {
    /// `title_link` first when it is a file on the server: `image_url` is only a
    /// thumbnail there, pixelated once shown large.
    pub source: String,
    /// The page an image from elsewhere comes from (a GIF search, a bot), shown
    /// as its title's link.
    pub link: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub title: Option<String>,
    pub description: Option<String>,
    /// 8.5 stores the text typed with an upload here, as the image's alt text.
    pub alt: Option<String>,
}

pub fn image_attachments(json: Option<&str>) -> Vec<ImageAttachment> {
    let Some(list) = json.and_then(|j| serde_json::from_str::<Vec<Value>>(j).ok()) else { return Vec::new() };
    let text = |a: &Value, k: &str| a.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    list.iter()
        .filter_map(|a| {
            let image = text(a, "image_url")?;
            let title_link = text(a, "title_link");
            let (source, link) = match title_link {
                Some(link) if link.starts_with('/') => (link, None),
                link => (image, link),
            };
            Some(ImageAttachment {
                source,
                link,
                width: a.pointer("/image_dimensions/width").and_then(Value::as_i64),
                height: a.pointer("/image_dimensions/height").and_then(Value::as_i64),
                title: text(a, "title"),
                description: text(a, "description"),
                alt: text(a, "image_alt"),
            })
        })
        .collect()
}

/// The Android layout: natural width clamped to [min_w, max_w], height at the
/// original's ratio capped at `max_h` (a very tall portrait gets cropped).
/// `image_dimensions` describes the thumbnail, but its ratio is the original's.
pub fn display_size(width: Option<i64>, height: Option<i64>, min_w: i64, max_w: i64, max_h: i64) -> (i32, i32) {
    let w = width.unwrap_or(max_w).clamp(min_w, max_w);
    let ratio = height.unwrap_or(w) as f64 / width.unwrap_or(w).max(1) as f64;
    let h = ((w as f64 * ratio).round() as i64).clamp(1, max_h);
    (w as i32, h as i32)
}

#[derive(Debug)]
pub struct Media {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

impl Media {
    /// Rocket.Chat answers a missing photo with a generated initials SVG:
    /// that is "no photo", and the gradient tile stays.
    pub fn is_placeholder(&self) -> bool {
        self.content_type.contains("svg") || self.bytes.trim_ascii_start().starts_with(b"<")
    }
}

pub struct MediaCache {
    rest: RestClient,
    /// A Mattermost account: photos are served by user id only.
    directory: Option<Arc<crate::mattermost::directory::Directory>>,
    /// A Slack account: photos are public CDN URLs, read without the session.
    slack: Option<Arc<crate::slack::directory::Directory>>,
    /// A Teams account: images on its object store need the skype token.
    teams: Option<Arc<crate::teams::sync::TeamsSync>>,
    entries: Mutex<HashMap<String, Arc<Media>>>,
    /// Files of encrypted rooms by path: the server holds only their ciphertext.
    keys: Mutex<HashMap<String, crate::e2e::FileEncryption>>,
}

impl MediaCache {
    pub fn new(rest: RestClient) -> Self {
        MediaCache {
            rest,
            directory: None,
            slack: None,
            teams: None,
            entries: Mutex::default(),
            keys: Mutex::default(),
        }
    }

    pub fn for_mattermost(rest: RestClient, directory: Arc<crate::mattermost::directory::Directory>) -> Self {
        MediaCache { directory: Some(directory), ..Self::new(rest) }
    }

    pub fn for_teams(rest: RestClient, teams: Arc<crate::teams::sync::TeamsSync>) -> Self {
        MediaCache { teams: Some(teams), ..Self::new(rest) }
    }

    pub fn for_slack(rest: RestClient, directory: Arc<crate::slack::directory::Directory>) -> Self {
        MediaCache { slack: Some(directory), ..Self::new(rest) }
    }

    /// The Mattermost route of a Rocket.Chat avatar path, the one the screens
    /// build. A room has no photo there.
    fn server_path(&self, path_or_url: &str) -> Result<String, RestError> {
        if let Some(slack) = &self.slack {
            return slack_path(slack, path_or_url);
        }
        let Some(directory) = &self.directory else { return Ok(path_or_url.to_owned()) };
        let Some(avatar) = path_or_url.strip_prefix("/avatar/") else { return Ok(path_or_url.to_owned()) };
        let (target, etag) = avatar.split_once("?etag=").map_or((avatar, None), |(t, e)| (t, Some(e)));
        let uid = match target.strip_prefix("uid/") {
            Some(uid) => Some(uid.to_owned()),
            None if target.starts_with("room/") => None,
            None => directory.id_of(target),
        };
        let uid = uid.ok_or_else(|| RestError::incomplete(&format!("{path_or_url}: no photo")))?;
        Ok(match etag {
            Some(etag) => format!("/api/v4/users/{uid}/image?_={etag}"),
            None => format!("/api/v4/users/{uid}/image"),
        })
    }
}

/// The profile image of the person a Rocket.Chat avatar path names, a custom
/// emoji or a file on Slack's file host. A room has no photo there, and
/// nothing else of the server's is read this way.
fn slack_path(directory: &crate::slack::directory::Directory, path_or_url: &str) -> Result<String, RestError> {
    if path_or_url.starts_with(crate::slack::sync::CUSTOM_EMOJI_ORIGIN)
        || url::Url::parse(path_or_url).is_ok_and(|url| crate::slack::translate::file_host(&url))
    {
        return Ok(path_or_url.to_owned());
    }
    let none = || RestError::incomplete(&format!("{path_or_url}: no photo"));
    slack_uid(directory, path_or_url).and_then(|uid| directory.avatar(&uid)).ok_or_else(none)
}

/// The person a Rocket.Chat avatar path names on a Slack account, by id.
fn slack_uid(directory: &crate::slack::directory::Directory, path_or_url: &str) -> Option<String> {
    let avatar = path_or_url.strip_prefix("/avatar/")?;
    let target = avatar.split_once("?etag=").map_or(avatar, |(t, _)| t);
    match target.strip_prefix("uid/") {
        Some(uid) => Some(uid.to_owned()),
        None if target.starts_with("room/") => None,
        None => directory.id_of(target),
    }
}

impl MediaCache {
    /// The keys of a decrypted message's files, each under every path that
    /// designates it: fetched from then on, they come out in clear.
    pub fn learn_keys(&self, attachments: &Value) {
        let mut keys = self.keys.lock().unwrap();
        for attachment in attachments.as_array().into_iter().flatten() {
            let Some(encryption) = crate::e2e::file_encryption(attachment) else { continue };
            for field in ["title_link", "image_url", "audio_url", "video_url"] {
                if let Some(path) = attachment.get(field).and_then(Value::as_str) {
                    keys.insert(path.to_owned(), encryption.clone());
                }
            }
        }
    }

    /// Downloaded bytes in clear: decrypted when the path is an encrypted file's.
    /// Whether the server holds only this file's ciphertext.
    pub fn encrypted(&self, path_or_url: &str) -> bool {
        self.keys.lock().unwrap().contains_key(path_or_url)
    }

    pub fn open(&self, path_or_url: &str, bytes: Vec<u8>) -> Result<Vec<u8>, RestError> {
        let Some(encryption) = self.keys.lock().unwrap().get(path_or_url).cloned() else { return Ok(bytes) };
        crate::e2e::decrypt_file(&bytes, &encryption)
            .map_err(|_| RestError::incomplete(&format!("{path_or_url}: undecipherable")))
    }

    pub async fn fetch(&self, path_or_url: &str) -> Result<Arc<Media>, RestError> {
        if let Some(hit) = self.entries.lock().unwrap().get(path_or_url) {
            return Ok(hit.clone());
        }
        if let Some(teams) = &self.teams
            && (crate::teams::translate::is_teams_image(path_or_url)
                || crate::teams::translate::is_graph_share(path_or_url))
        {
            let (bytes, content_type) = teams.fetch_image(path_or_url).await?;
            let media = Arc::new(Media { bytes, content_type });
            let mut entries = self.entries.lock().unwrap();
            if entries.len() >= CACHE_LIMIT {
                entries.clear();
            }
            entries.insert(path_or_url.to_owned(), media.clone());
            return Ok(media);
        }
        let path = match (self.server_path(path_or_url), &self.slack) {
            // Slack names nobody up front: a person no loaded message named
            // yet (a direct conversation's partner, me) is read on demand.
            (Err(_), Some(slack)) if let Some(uid) = slack_uid(slack, path_or_url) => {
                slack.ensure(&self.rest, [uid]).await;
                self.server_path(path_or_url)?
            }
            (path, _) => path?,
        };
        let (bytes, content_type) = self.rest.fetch_protected(&path).await?;
        let bytes = self.open(path_or_url, bytes)?;
        let media = Arc::new(Media { bytes, content_type });
        let mut entries = self.entries.lock().unwrap();
        if entries.len() >= CACHE_LIMIT {
            entries.clear();
        }
        entries.insert(path_or_url.to_owned(), media.clone());
        Ok(media)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slack_avatar_paths_name_people_by_id_or_known_username() {
        let directory = crate::slack::directory::Directory::default();
        directory.remember(crate::slack::directory::User {
            id: "U1".to_owned(),
            username: "alice".to_owned(),
            ..Default::default()
        });
        assert_eq!(slack_uid(&directory, "/avatar/uid/U2").as_deref(), Some("U2"));
        assert_eq!(slack_uid(&directory, "/avatar/alice?etag=x").as_deref(), Some("U1"));
        assert_eq!(slack_uid(&directory, "/avatar/room/C1"), None);
        assert!(slack_path(&directory, "/avatar/alice").is_err(), "known, but no photo read yet");
    }

    #[test]
    fn slack_reads_its_file_host_and_nothing_else_of_the_web() {
        let directory = crate::slack::directory::Directory::default();
        let file = "https://files.slack.com/files-tmb/T1-F1-x/a_360.png";
        assert_eq!(slack_path(&directory, file).unwrap(), file);
        assert!(slack_path(&directory, "https://files.slack.com.evil.example/a.png").is_err());
        assert!(slack_path(&directory, "http://files.slack.com/a.png").is_err());
    }

    #[test]
    fn protected_disk_cache_keys_separate_accounts_servers_and_punctuation() {
        assert_ne!(
            account_cache_key("https://chat.example", "alice"),
            account_cache_key("https://chat.example", "bob")
        );
        assert_ne!(
            account_cache_key("https://chat-a.example", "alice"),
            account_cache_key("https://chat.a.example", "alice")
        );
        assert_eq!(
            account_cache_key("https://chat.example/", "alice"),
            account_cache_key("https://chat.example", "alice")
        );
        let filename = attachment_cache_name("/file-upload/same", "../..\\secret.pdf");
        assert!(!filename.contains('/'));
        assert!(!filename.contains('\\'));
        assert!(filename.ends_with(".pdf"));
        assert_ne!(filename, attachment_cache_name("/file-upload/other", "../..\\secret.pdf"));
    }

    #[test]
    fn avatar_paths() {
        assert_eq!(avatar_path(AvatarTarget::User("bob"), None), "/avatar/bob");
        assert_eq!(avatar_path(AvatarTarget::User("jean pierre"), Some("e1")), "/avatar/jean%20pierre?etag=e1");
        assert_eq!(avatar_path(AvatarTarget::Uid("U1"), Some("")), "/avatar/uid/U1");
        assert_eq!(avatar_path(AvatarTarget::Room("R1"), None), "/avatar/room/R1");
    }

    #[test]
    fn image_attachments_prefer_the_original() {
        let json = r#"[{"title":"cat.png","title_link":"/file-upload/1/cat.png","image_url":"/file-upload/2/thumb-cat.png",
            "image_dimensions":{"width":480,"height":360},"description":"my cat","image_alt":"a cat"},
            {"title":"doc.pdf","title_link":"/file-upload/3/doc.pdf"},
            {"image_url":"/file-upload/4/only.png"}]"#;
        let images = image_attachments(Some(json));
        assert_eq!(images.len(), 2);
        assert_eq!(images[0].source, "/file-upload/1/cat.png");
        assert_eq!((images[0].width, images[0].height), (Some(480), Some(360)));
        assert_eq!(images[0].description.as_deref(), Some("my cat"));
        assert_eq!(images[0].alt.as_deref(), Some("a cat"));
        assert_eq!(images[1].source, "/file-upload/4/only.png");
        assert_eq!(images[0].link, None);
        assert!(image_attachments(None).is_empty());
        assert!(image_attachments(Some("not json")).is_empty());
    }

    #[test]
    fn images_from_elsewhere_keep_their_page_as_a_link() {
        let json = r#"[{"title":"fight","title_link":"https://giphy.com/gifs/fight-abc","image_url":"https://media.giphy.com/media/abc/giphy.gif"}]"#;
        let images = image_attachments(Some(json));
        assert_eq!(images[0].source, "https://media.giphy.com/media/abc/giphy.gif");
        assert_eq!(images[0].link.as_deref(), Some("https://giphy.com/gifs/fight-abc"));
        assert_eq!(images[0].title.as_deref(), Some("fight"));
    }

    #[test]
    fn display_size_follows_the_android_layout() {
        assert_eq!(display_size(Some(480), Some(360), 120, 360, 300), (360, 270));
        assert_eq!(display_size(Some(80), Some(80), 120, 360, 300), (120, 120));
        assert_eq!(display_size(Some(300), Some(1200), 120, 360, 300), (300, 300));
        assert_eq!(display_size(None, None, 120, 360, 300), (360, 300));
    }

    #[test]
    fn files_of_encrypted_rooms_come_out_in_clear() {
        let cache = MediaCache::new(RestClient::new("https://chat.example.com".parse().unwrap()));
        let plain = b"%PDF-1.4 secret".repeat(50);
        let sent = crate::e2e::encrypt_file(&plain).unwrap();
        cache.learn_keys(&serde_json::json!([{
            "title_link": "/file-upload/f1/h", "image_url": "/file-upload/f1/h",
            "encryption": {"key": sent.key, "iv": sent.iv}, "hashes": {"sha256": sent.sha256},
        }]));
        assert_eq!(cache.open("/file-upload/f1/h", sent.data.clone()).unwrap(), plain);
        assert_eq!(cache.open("/file-upload/other/x.png", b"clear".to_vec()).unwrap(), b"clear");
        let mut altered = sent.data;
        altered[0] ^= 1;
        assert!(cache.open("/file-upload/f1/h", altered).is_err());
    }

    #[test]
    fn svg_is_a_placeholder() {
        let svg = Media { bytes: b"<svg xmlns=...".to_vec(), content_type: "image/svg+xml".into() };
        let sniffed = Media { bytes: b"  <?xml version".to_vec(), content_type: "application/octet-stream".into() };
        let png = Media { bytes: b"\x89PNG\r\n".to_vec(), content_type: "image/png".into() };
        assert!(svg.is_placeholder() && sniffed.is_placeholder());
        assert!(!png.is_placeholder());
    }
}
