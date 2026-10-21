//! What I do in a Teams conversation: send, edit, delete, react, mark read.

use reqwest::Method;
use serde_json::{Value, json};

use super::auth::refusal;
use super::sync::TeamsSync;
use super::translate::{self, split_id};
use crate::rest::RestError;

/// Markdown typed in the composer as the HTML Teams stores: text escaped, lines kept.
pub fn to_html(text: &str) -> String {
    let escaped = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
    let lines: Vec<String> = escaped.lines().map(|l| format!("<p>{l}</p>")).collect();
    if lines.is_empty() { "<p></p>".to_owned() } else { lines.concat() }
}

fn ids(id: &str) -> Result<(&str, &str), RestError> {
    split_id(id).ok_or_else(|| refusal("message_id", 0))
}

impl TeamsSync {
    /// Sends `text` with my `client_id` for the conversation to echo; answers
    /// the server id it minted.
    pub async fn send(&self, rid: &str, text: &str, client_id: &str) -> Result<String, RestError> {
        let body = json!({
            "content": to_html(text),
            "messagetype": "RichText/Html",
            "contenttype": "text",
            "clientmessageid": client_id,
            "imdisplayname": self.directory.shown(self.me()),
        });
        let url = self.conversation_url(rid, &["messages"], "").await?;
        let answer = self.chat(Method::POST, url, Some(&body)).await?;
        let id = translate::int_of(&answer.body, "OriginalArrivalTime")
            .ok_or_else(|| refusal("send_answer", answer.status))?;
        Ok(id.to_string())
    }

    pub async fn edit(&self, msg_id: &str, text: &str) -> Result<(), RestError> {
        let (rid, server) = ids(msg_id)?;
        let body = json!({"content": to_html(text), "messagetype": "RichText/Html", "contenttype": "text"});
        let url = self.conversation_url(rid, &["messages", server], "").await?;
        self.chat(Method::PUT, url, Some(&body)).await?;
        self.refresh_one(msg_id).await;
        Ok(())
    }

    pub async fn delete(&self, msg_id: &str) -> Result<(), RestError> {
        let (rid, server) = ids(msg_id)?;
        let url = self.conversation_url(rid, &["messages", server], "").await?;
        self.chat(Method::DELETE, url, None).await?;
        Ok(())
    }

    /// Adds or removes my reaction; only Teams' classic reactions are sent.
    pub async fn react(&self, msg_id: &str, shortcode: &str, add: bool) -> Result<(), RestError> {
        let (rid, server) = ids(msg_id)?;
        let key = translate::reaction_key(shortcode).ok_or_else(|| refusal("reaction_not_supported", 0))?;
        let url = self.conversation_url(rid, &["messages", server, "properties"], "name=emotions").await?;
        let (method, body) = if add {
            (Method::PUT, json!({"emotions": {"key": key, "value": chrono::Utc::now().timestamp_millis()}}))
        } else {
            (Method::DELETE, json!({"emotions": {"key": key}}))
        };
        self.chat(method, url, Some(&body)).await?;
        self.refresh_one(msg_id).await;
        Ok(())
    }

    /// Moves my read horizon to the room's newest stored message, never back.
    pub async fn mark_read(&self, rid: &str) -> Result<(), RestError> {
        let Some(newest) = self.unmarked_newest(rid) else { return Ok(()) };
        let horizon = format!("{newest};{};{newest}", chrono::Utc::now().timestamp_millis());
        let url = self.conversation_url(rid, &["properties"], "name=consumptionhorizon").await?;
        self.chat(Method::PUT, url, Some(&json!({"consumptionhorizon": horizon}))).await?;
        self.note_marked(rid, newest);
        Ok(())
    }

    async fn refresh_one(&self, msg_id: &str) {
        let Some((rid, server)) = split_id(msg_id) else { return };
        let Ok(url) =
            self.conversation_url(rid, &["messages", server], "view=msnp24Equivalent|supportsMessageProperties").await
        else {
            return;
        };
        if let Ok(answer) = self.chat(Method::GET, url, None).await {
            self.ingest_one(rid, &answer.body);
        }
    }
}

/// Whether a stored message carries the client id a send gave it.
pub fn echoes(raw: &Value, client_id: &str) -> bool {
    translate::str_of(raw, "clientmessageid") == Some(client_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_text_is_escaped_html() {
        assert_eq!(to_html("a <b> & \"c\"\nnext"), "<p>a &lt;b&gt; &amp; &quot;c&quot;</p><p>next</p>");
        assert_eq!(to_html(""), "<p></p>");
    }
}
