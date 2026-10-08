use crate::{
    MediaData,
    model::RvError,
    native::NativeChat,
    on_tokio,
    writing::{Suggestion, Suggestions},
};

#[uniffi::export]
impl NativeChat {
    pub fn custom_emoji(&self, code: String) -> Option<String> {
        self.session.custom_emoji(&code)
    }
    pub fn custom_emoji_names(&self) -> Vec<String> {
        self.session.custom_emoji_names()
    }
    /// The reactions the message menu offers first (`:code:`), the ones I use
    /// most on this account; without `custom` (a private conversation),
    /// standard emoji only.
    pub fn quick_reactions(&self, custom: bool) -> Vec<String> {
        let s = &self.session;
        crate::reactions::quick(&crate::reactions::usage(&self.dirs.config, &s.info), |code| {
            custom && s.custom_emoji(code).is_some()
        })
    }
    pub fn emoji_current(&self, path: String) -> bool {
        self.session.emoji_current(&path)
    }
    pub async fn emoji_media(&self, path: String) -> Result<MediaData, RvError> {
        let s = self.session.clone();
        on_tokio(async move {
            s.emoji_media(&path).await.map(|m| MediaData {
                bytes: m.bytes,
                content_type: m.content_type,
                placeholder: false,
            })
        })
        .await
        .map_err(|e| rv_core::native::rest_error(e).into())
    }
    /// What to offer for the text before the cursor in `rid`: its commands
    /// after a leading `/`, custom emojis after `:`.
    pub fn suggestions(&self, rid: String, before_cursor: String) -> Option<Suggestions> {
        if let Some(prefix) = rv_core::commands::query(&before_cursor) {
            return crate::writing::command_suggestions(&self.session.loaded_room_commands(&rid), prefix, None);
        }
        let q = rv_core::completion::query(&before_cursor)?;
        if q.trigger != rv_core::completion::Trigger::Emoji {
            return None;
        }
        let mut items: Vec<_> = self
            .session
            .custom_emoji_codes(&q.prefix)
            .into_iter()
            .take(8)
            .map(|code| Suggestion {
                insert: format!(":{code}: "),
                label: format!(":{code}:"),
                glyph: None,
                image: self.session.custom_emoji(&code),
                detail: None,
            })
            .collect();
        items.extend(rv_core::emoji::complete(&q.prefix, 8).into_iter().map(|(code, glyph)| Suggestion {
            insert: format!("{glyph} "),
            label: format!(":{code}:"),
            glyph: Some(glyph.to_owned()),
            image: None,
            detail: None,
        }));
        items.truncate(8);
        (!items.is_empty()).then_some(Suggestions { start: q.start as u32, items })
    }
}
