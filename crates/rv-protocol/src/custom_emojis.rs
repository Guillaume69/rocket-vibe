//! Instance-scoped custom images. Their catalogue never grants room authority.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CustomEmoji {
    pub id: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub file_id: String,
    pub sha256: String,
    pub media_type: String,
    pub bytes: String,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct EmojiCatalog {
    pub revision: String,
    pub items: Vec<CustomEmoji>,
}

pub fn shortcode(value: &str) -> Option<&str> {
    let value = value
        .strip_prefix(':')
        .and_then(|s| s.strip_suffix(':'))
        .unwrap_or(value);
    (!value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_+-".contains(&b)))
    .then_some(value)
}

pub fn validate(catalog: &EmojiCatalog) -> bool {
    let canonical = |s: &str| s.parse::<i64>().is_ok_and(|n| n >= 0 && n.to_string() == s);
    if !canonical(&catalog.revision) || catalog.items.len() > 512 {
        return false;
    }
    let mut codes = std::collections::HashSet::new();
    let mut ids = std::collections::HashSet::new();
    catalog.items.iter().all(|e| {
        !e.id.is_empty()
            && e.id.len() <= 128
            && e.id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            && ids.insert(&e.id)
            && canonical(&e.revision)
            && e.revision != "0"
            && e.revision.parse::<i64>().unwrap() <= catalog.revision.parse::<i64>().unwrap()
            && [&e.file_id, &e.sha256].iter().all(|v| {
                v.len() == 64
                    && v.bytes()
                        .all(|b| b.is_ascii_digit() || b"abcdef".contains(&b))
            })
            && matches!(e.media_type.as_str(), "image/png" | "image/gif")
            && e.bytes
                .parse::<u32>()
                .is_ok_and(|n| n > 0 && n <= 1024 * 1024 && n.to_string() == e.bytes)
            && e.aliases.len() <= 8
            && std::iter::once(&e.name).chain(e.aliases.iter()).all(|c| {
                shortcode(c) == Some(c.as_str())
                    && crate::emojis::canonical(c).is_none()
                    && codes.insert(c)
            })
    })
}
