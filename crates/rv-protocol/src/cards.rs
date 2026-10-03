//! Bounded integration attachments. Text and navigation only; no executable
//! embeds, actions, authenticated URLs, or remotely loaded media.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const MAX_CARDS: usize = 3;
pub const MAX_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CardField {
    pub title: String,
    pub value: String,
    #[serde(default)]
    pub short: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct IntegrationCard {
    pub author: Option<String>,
    pub title: Option<String>,
    pub url: Option<String>,
    pub text: Option<String>,
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<CardField>,
}
fn text(value: &str, limit: usize, multiline: bool) -> bool {
    !value.trim().is_empty()
        && value.len() <= limit
        && !value
            .chars()
            .any(|c| c.is_control() && !(multiline && matches!(c, '\n' | '\t' | '\r')))
}
pub fn validate(cards: &[IntegrationCard]) -> bool {
    cards.len() <= MAX_CARDS
        && serde_json::to_vec(cards).is_ok_and(|bytes| bytes.len() <= MAX_BYTES)
        && cards.iter().all(|card| {
            card.author.as_ref().is_none_or(|s| text(s, 256, false))
                && card.title.as_ref().is_none_or(|s| text(s, 512, false))
                && card.text.as_ref().is_none_or(|s| text(s, 8192, true))
                && card.url.as_ref().is_none_or(|s| {
                    s.len() <= 2048
                        && !s.chars().any(char::is_control)
                        && url::Url::parse(s).is_ok_and(|u| {
                            matches!(u.scheme(), "http" | "https")
                                && u.host().is_some()
                                && u.username().is_empty()
                                && u.password().is_none()
                        })
                })
                && card.color.as_ref().is_none_or(|s| {
                    s.len() == 7
                        && s.starts_with('#')
                        && s.bytes().skip(1).all(|b| b.is_ascii_hexdigit())
                })
                && card.fields.len() <= 12
                && card
                    .fields
                    .iter()
                    .all(|f| text(&f.title, 128, false) && text(&f.value, 2048, true))
                && (card.title.is_some() || card.text.is_some() || !card.fields.is_empty())
        })
}
