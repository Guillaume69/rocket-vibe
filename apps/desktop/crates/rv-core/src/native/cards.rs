//! Translate native integration data into the existing attachment renderer.
use super::Error;
use rv_protocol::cards::IntegrationCard;
use serde_json::{Value, json};

pub(super) fn attachments(cards: &[IntegrationCard]) -> Result<Vec<Value>, Error> {
    if !rv_protocol::cards::validate(cards) {
        return Err(Error::Protocol("invalid_card"));
    }
    Ok(cards
        .iter()
        .map(|c| {
            json!({
                "native_card":true,"author_name":c.author,"title":c.title,
                "title_link":c.url,"text":c.text,"color":c.color,"fields":c.fields
            })
        })
        .collect())
}
