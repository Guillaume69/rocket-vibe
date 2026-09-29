//! What the composer offers while typing: `@` mentions and `:` emoji, and
//! the emoji picker's categories.

use rv_core::completion::{self, Trigger};

use crate::Chat;

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Suggestion {
    /// Replaces the typed `@prefix` or `:prefix`, a space after it.
    pub insert: String,
    pub label: String,
    pub glyph: Option<String>,
    /// A server emoji's image path, for `Chat::media`.
    pub image: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Suggestions {
    /// Where the `@` or `:` is, in Unicode scalars from the text's start.
    pub start: u32,
    pub items: Vec<Suggestion>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EmojiCategory {
    pub name: String,
    /// Shortcodes, with colons.
    pub shortcodes: Vec<String>,
    pub glyphs: Vec<String>,
}

const SUGGESTED: usize = 8;

#[uniffi::export]
impl Chat {
    /// What to offer for the text before the cursor, or None when it ends
    /// in neither `@word` nor `:word`.
    pub fn suggestions(&self, rid: String, before_cursor: String) -> Option<Suggestions> {
        let q = completion::query(&before_cursor)?;
        let items: Vec<Suggestion> = match q.trigger {
            Trigger::Mention => {
                let recent = self.session.store.recent_authors(&rid, 50);
                completion::mentions(&q.prefix, &recent, &self.session.info.username, SUGGESTED)
                    .into_iter()
                    .map(|name| Suggestion {
                        insert: format!("@{name} "),
                        label: format!("@{name}"),
                        glyph: None,
                        image: None,
                    })
                    .collect()
            }
            Trigger::Emoji => {
                let mut items: Vec<Suggestion> = self
                    .session
                    .custom_emoji_codes(&q.prefix)
                    .into_iter()
                    .take(SUGGESTED)
                    .map(|code| Suggestion {
                        insert: format!(":{code}: "),
                        label: format!(":{code}:"),
                        glyph: None,
                        image: self.session.custom_emoji(&code),
                    })
                    .collect();
                items.extend(rv_core::emoji::complete(&q.prefix, SUGGESTED).into_iter().map(|(code, glyph)| {
                    Suggestion {
                        insert: format!("{glyph} "),
                        label: format!(":{code}:"),
                        glyph: Some(glyph.to_owned()),
                        image: None,
                    }
                }));
                items.truncate(SUGGESTED);
                items
            }
        };
        (!items.is_empty()).then_some(Suggestions { start: q.start as u32, items })
    }
}

/// The emoji picker's pages, in the Android app's order.
#[uniffi::export]
pub fn emoji_categories() -> Vec<EmojiCategory> {
    rv_core::emoji::CATEGORIES
        .iter()
        .map(|name| {
            let codes = rv_core::emoji::category(name);
            EmojiCategory {
                name: (*name).to_owned(),
                glyphs: codes.iter().map(|c| rv_core::emoji::unicode(c).unwrap_or_default().to_owned()).collect(),
                shortcodes: codes.iter().map(|c| format!(":{}:", c.trim_matches(':'))).collect(),
            }
        })
        .collect()
}

