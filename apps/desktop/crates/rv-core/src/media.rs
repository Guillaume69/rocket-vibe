//! Avatars and attached files. The target server protects both
//! (`FileUpload_ProtectFiles`, `Accounts_AvatarBlockUnauthenticatedAccess`):
//! every read carries `rc_uid`/`rc_token` in the query.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use url::Url;

use crate::rest::{Credentials, RestClient, RestError};

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

/// The token only ever goes to OUR server. An attachment URL comes from a
/// message field, so ultimately from anyone: `chat.sendMessage` accepts
/// arbitrary `attachments`, and an absolute link to a third-party host would
/// otherwise leave with our credentials on it. Off-origin, the URL stays bare:
/// a protected file then fails to load, which is the right failure.
pub fn protected_url(base: &Url, credentials: Option<&Credentials>, path_or_url: &str) -> Option<Url> {
    let mut url = if path_or_url.starts_with("http://") || path_or_url.starts_with("https://") {
        Url::parse(path_or_url).ok()?
    } else {
        // Concatenated, not joined: a server under a sub-path already puts it in its file paths.
        Url::parse(&format!("{}{path_or_url}", base.as_str().trim_end_matches('/'))).ok()?
    };
    if let Some(c) = credentials
        && url.origin() == base.origin()
    {
        url.query_pairs_mut().append_pair("rc_uid", &c.user_id).append_pair("rc_token", &c.auth_token);
    }
    Some(url)
}

/// The etag of a photo that was removed: the URL must still change, or the
/// cached old photo would be served under the old one.
pub const NO_PHOTO: &str = "none";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageAttachment {
    /// `title_link` first: `image_url` is only a thumbnail, pixelated once shown large.
    pub source: String,
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
            Some(ImageAttachment {
                source: text(a, "title_link").unwrap_or(image),
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
    entries: Mutex<HashMap<String, Arc<Media>>>,
    /// Files of encrypted rooms by path: the server holds only their ciphertext.
    keys: Mutex<HashMap<String, crate::e2e::FileEncryption>>,
}

impl MediaCache {
    pub fn new(rest: RestClient) -> Self {
        MediaCache { rest, entries: Mutex::default(), keys: Mutex::default() }
    }

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
    pub fn open(&self, path_or_url: &str, bytes: Vec<u8>) -> Result<Vec<u8>, RestError> {
        let Some(encryption) = self.keys.lock().unwrap().get(path_or_url).cloned() else { return Ok(bytes) };
        crate::e2e::decrypt_file(&bytes, &encryption)
            .map_err(|_| RestError::incomplete(&format!("{path_or_url}: undecipherable")))
    }

    pub async fn fetch(&self, path_or_url: &str) -> Result<Arc<Media>, RestError> {
        if let Some(hit) = self.entries.lock().unwrap().get(path_or_url) {
            return Ok(hit.clone());
        }
        let (bytes, content_type) = self.rest.fetch_protected(path_or_url).await?;
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

    fn creds() -> Credentials {
        Credentials { auth_token: "tok".into(), user_id: "uid".into() }
    }

    #[test]
    fn avatar_paths() {
        assert_eq!(avatar_path(AvatarTarget::User("bob"), None), "/avatar/bob");
        assert_eq!(avatar_path(AvatarTarget::User("jean pierre"), Some("e1")), "/avatar/jean%20pierre?etag=e1");
        assert_eq!(avatar_path(AvatarTarget::Uid("U1"), Some("")), "/avatar/uid/U1");
        assert_eq!(avatar_path(AvatarTarget::Room("R1"), None), "/avatar/room/R1");
    }

    #[test]
    fn token_only_goes_to_our_origin() {
        let base: Url = "https://chat.example.com".parse().unwrap();
        let ours = protected_url(&base, Some(&creds()), "/file-upload/f/a.png").unwrap();
        assert_eq!(ours.as_str(), "https://chat.example.com/file-upload/f/a.png?rc_uid=uid&rc_token=tok");
        let with_query = protected_url(&base, Some(&creds()), "/avatar/bob?etag=e1").unwrap();
        assert_eq!(with_query.as_str(), "https://chat.example.com/avatar/bob?etag=e1&rc_uid=uid&rc_token=tok");
        let theirs = protected_url(&base, Some(&creds()), "https://evil.example.org/x.png").unwrap();
        assert_eq!(theirs.as_str(), "https://evil.example.org/x.png");
        let other_port = protected_url(&base, Some(&creds()), "https://chat.example.com:8443/x.png").unwrap();
        assert!(other_port.query().is_none());
        assert!(protected_url(&base, None, "/x.png").unwrap().query().is_none());
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
        assert!(image_attachments(None).is_empty());
        assert!(image_attachments(Some("not json")).is_empty());
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
