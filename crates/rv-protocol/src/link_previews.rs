//! Native link metadata. HTML, executable embeds and remote image URLs are
//! deliberately absent; a preview image is an immutable, protected resource.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const MAX_PREVIEWS: usize = 3;
pub const MAX_URL_BYTES: usize = 2048;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PreviewKind {
    Page,
    Image,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct PreviewImage {
    pub file_id: String,
    pub sha256: String,
    pub bytes: String,
    pub width: u32,
    pub height: u32,
    pub media_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct LinkPreview {
    /// Original link in the message, including its fragment. The final URL of
    /// a redirect never replaces the author's navigation target.
    pub url: String,
    pub kind: PreviewKind,
    pub title: Option<String>,
    pub description: Option<String>,
    pub site: Option<String>,
    pub image: Option<PreviewImage>,
}

pub fn validate_image(image: &PreviewImage) -> bool {
    fn digest(s: &str) -> bool {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
    digest(&image.file_id)
        && digest(&image.sha256)
        && image.media_type == "image/png"
        && image.width > 0
        && image.width <= 1200
        && image.height > 0
        && image.height <= 1200
        && image
            .bytes
            .parse::<u64>()
            .is_ok_and(|n| n > 0 && n <= 4 * 1024 * 1024 && n.to_string() == image.bytes)
}
pub fn validate(items: &[LinkPreview]) -> bool {
    fn text(s: &Option<String>, max: usize) -> bool {
        s.as_ref()
            .is_none_or(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control))
    }
    items.len() <= MAX_PREVIEWS
        && items.iter().enumerate().all(|(index, item)| {
            item.url.len() <= MAX_URL_BYTES
                && url::Url::parse(&item.url).is_ok_and(|u| {
                    matches!(u.scheme(), "http" | "https")
                        && u.host().is_some()
                        && u.username().is_empty()
                        && u.password().is_none()
                })
                && !item.url.chars().any(char::is_control)
                && !items[..index].iter().any(|old| old.url == item.url)
                && text(&item.title, 512)
                && text(&item.description, 2048)
                && text(&item.site, 256)
                && item.image.as_ref().is_none_or(validate_image)
                && match item.kind {
                    PreviewKind::Page => item.title.is_some() || item.image.is_some(),
                    PreviewKind::Image => item.image.is_some(),
                }
        })
}
