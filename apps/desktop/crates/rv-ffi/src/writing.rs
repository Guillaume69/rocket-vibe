//! What the composer offers while typing: `/` commands, `@` mentions and
//! `:` emoji, and the emoji picker's categories.

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
    /// Under the label: what a command does.
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Suggestions {
    /// Where the `/`, `@` or `:` is, in Unicode scalars from the text's start.
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

/// Every command matching what follows the `/`, the whole list after `/` alone.
pub(crate) fn command_suggestions(
    commands: &[rv_core::commands::Command],
    prefix: &str,
    granted: Option<&[String]>,
) -> Option<Suggestions> {
    let items: Vec<Suggestion> = rv_core::commands::complete(commands, prefix, granted, usize::MAX)
        .into_iter()
        .map(|c| Suggestion {
            insert: format!("/{} ", c.name),
            label: if c.params.is_empty() { format!("/{}", c.name) } else { format!("/{}  {}", c.name, c.params) },
            glyph: None,
            image: None,
            detail: (!c.description.is_empty()).then(|| c.description.clone()),
        })
        .collect();
    (!items.is_empty()).then_some(Suggestions { start: 0, items })
}

#[uniffi::export]
impl Chat {
    /// What to offer for the text before the cursor, or None when it is
    /// neither a `/command` being typed nor ends in `@word` or `:word`.
    pub fn suggestions(&self, rid: String, before_cursor: String) -> Option<Suggestions> {
        if let Some(prefix) = rv_core::commands::query(&before_cursor) {
            let commands = self.commands.lock().unwrap();
            let granted = self.rules.lock().unwrap().1.get(&rid).cloned();
            return command_suggestions(&commands, prefix, granted.as_deref());
        }
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
                        detail: None,
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
                        detail: None,
                    })
                    .collect();
                items.extend(rv_core::emoji::complete(&q.prefix, SUGGESTED).into_iter().map(|(code, glyph)| {
                    Suggestion {
                        insert: format!("{glyph} "),
                        label: format!(":{code}:"),
                        glyph: Some(glyph.to_owned()),
                        image: None,
                        detail: None,
                    }
                }));
                items.truncate(SUGGESTED);
                items
            }
        };
        (!items.is_empty()).then_some(Suggestions { start: q.start as u32, items })
    }
}

/// The composer's text after a line break that continues a list.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ListBreak {
    pub text: String,
    /// Where the cursor goes, in Unicode scalars from the text's start.
    pub cursor: u32,
}

/// The line break key on a list item (`cursor` in Unicode scalars): the next
/// item's marker, the same bullet or the next number, or the list's end on an
/// item left empty. None where a plain line break is right.
#[uniffi::export]
pub fn list_break(text: String, cursor: u32) -> Option<ListBreak> {
    rv_core::compose::list_break(&text, cursor as usize)
        .map(|edited| ListBreak { text: edited.text, cursor: edited.start as u32 })
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

#[cfg(test)]
mod tests {
    #[test]
    fn a_list_goes_on_after_a_line_break() {
        let next = super::list_break("- é".into(), 3).unwrap();
        assert_eq!(
            (next.text.as_str(), next.cursor),
            (
                "- é
- ", 6
            )
        );
        assert!(super::list_break("plain".into(), 5).is_none());
    }

    #[test]
    fn the_picker_has_every_category_filled() {
        let categories = super::emoji_categories();
        assert_eq!(categories.len(), rv_core::emoji::CATEGORIES.len());
        for c in &categories {
            assert!(!c.shortcodes.is_empty(), "{}", c.name);
            assert_eq!(c.shortcodes.len(), c.glyphs.len());
        }
        let people = &categories[0];
        let smile = people.shortcodes.iter().position(|s| s == ":smile:").expect(":smile:");
        assert_eq!(people.glyphs[smile], "😄");
    }
}
