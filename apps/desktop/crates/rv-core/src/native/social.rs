use super::{Error, NativeSession};
pub use rv_protocol::social::*;
use std::time::Instant;
impl NativeSession {
    pub fn social_supported(&self, feature: &str) -> bool {
        self.supported_features().iter().any(|f| f == feature)
    }
    pub fn can_social(&self, room: &str) -> bool {
        self.social_supported("social_cards") && self.store.room_encrypted(room).is_ok_and(|e| !e)
    }
    async fn social_access(&self, feature: &str) -> Result<(), Error> {
        self.ready()?;
        if !self.social_supported(feature) {
            return Err(Error::Protocol("unsupported_feature"));
        }
        self.identity().await?;
        self.ready()?;
        Ok(())
    }
    pub async fn create_social(&self, room: &str, input: &CreateSocial) -> Result<(), Error> {
        self.social_access("social_cards").await?;
        if !self.can_social(room) {
            return Err(Error::Protocol("crypto_required"));
        }
        self.client.create_social(room, input).await?;
        Ok(())
    }
    pub async fn answer_social(&self, id: &str, input: &AnswerSocial) -> Result<(), Error> {
        self.social_access("social_cards").await?;
        self.client.answer_social(id, input).await?;
        Ok(())
    }
    pub async fn close_poll(&self, id: &str, input: &ClosePoll) -> Result<(), Error> {
        self.social_access("social_cards").await?;
        self.client.close_poll(id, input).await?;
        Ok(())
    }
    pub async fn gifs(&self, query: &str) -> Result<Vec<GifItem>, Error> {
        self.social_access("giphy").await?;
        let value = self.client.gifs(query, false).await?;
        self.ready()?;
        Ok(value.items)
    }
    pub async fn stickers(&self) -> Result<Vec<Sticker>, Error> {
        self.social_access("sticker_shelf").await?;
        let value = self.client.stickers().await?;
        self.ready()?;
        Ok(value.stickers)
    }
    pub async fn save_sticker(&self, input: &SaveSticker) -> Result<(), Error> {
        self.social_access("sticker_shelf").await?;
        self.client.save_sticker(input).await?;
        Ok(())
    }
    pub async fn remove_sticker(&self, id: &str) -> Result<(), Error> {
        self.social_access("sticker_shelf").await?;
        self.client.remove_sticker(id).await?;
        Ok(())
    }
    pub async fn send_image(&self, room: &str, input: &SendImage) -> Result<(), Error> {
        self.social_access("sticker_shelf").await?;
        self.client.send_image(room, input).await?;
        Ok(())
    }
    pub async fn react_voice(&self, room: &str, emoji: &str, operation: &str) -> Result<(), Error> {
        self.social_access("voice_reactions").await?;
        self.client.react_voice(room, &ReactVoice { operation_id: operation.into(), emoji: emoji.into() }).await?;
        Ok(())
    }
    pub fn voice_reactions(&self, room: &str) -> Vec<VoiceReaction> {
        let live = self.live.lock().unwrap();
        if !live.until.is_some_and(|t| t > Instant::now()) {
            return vec![];
        }
        live.state.iter().flat_map(|s| s.voice_reactions.clone()).filter(|r| r.room_id == room).collect()
    }
}
pub fn parse_attachment(raw: Option<&str>) -> Option<SocialCard> {
    let value: serde_json::Value = serde_json::from_str(raw?).ok()?;
    value.as_array()?.iter().find_map(|a| serde_json::from_value(a.get("native_social")?.clone()).ok())
}
