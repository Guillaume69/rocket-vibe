//! Rocket.Chat GIF previews and a device-local reusable image shelf.
use crate::{
    rest::{CallOptions, RestError},
    session::Session,
    sync::Backend,
};
use rv_protocol::social::{Sticker, public_image};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GifPreview {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub value: String,
}
pub fn previews(value: &Value) -> Vec<GifPreview> {
    value
        .get("preview")
        .and_then(|p| p.get("items"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(10)
        .filter_map(|v| {
            let p: GifPreview = serde_json::from_value(v.clone()).ok()?;
            (p.kind == "image" && p.id.len() <= 256 && public_image(&p.value)).then_some(p)
        })
        .collect()
}
impl Session {
    pub async fn gif_previews(&self, room: &str, query: &str) -> Result<Vec<GifPreview>, RestError> {
        if !matches!(self.backend(), Backend::RocketChat) || !self.commands().await?.iter().any(|c| c.name == "giphy") {
            return Err(RestError::incomplete("GIPHY is unavailable on this server"));
        }
        let value = self
            .rest
            .get("commands.preview", CallOptions::params([("command", "giphy"), ("roomId", room), ("params", query)]))
            .await?;
        Ok(previews(&value))
    }
    pub async fn send_gif(
        &self,
        room: &str,
        query: &str,
        item: &GifPreview,
        operation: &str,
        root: Option<&str>,
    ) -> Result<(), RestError> {
        if !public_image(&item.value) || item.kind != "image" {
            return Err(RestError::incomplete("Invalid GIF"));
        }
        let mut body = json!({"command":"giphy","roomId":room,"params":query,"triggerId":operation,"previewItem":item});
        if let Some(root) = root {
            body["tmid"] = json!(root)
        }
        self.rest.post("commands.preview", CallOptions::body(body)).await?;
        Ok(())
    }
    pub fn stickers(&self) -> Result<Vec<Sticker>, RestError> {
        self.store
            .read(|c| {
                c.prepare("SELECT id,name,url FROM sticker_shelf ORDER BY name,id LIMIT 200")?
                    .query_map([], |r| Ok(Sticker { id: r.get(0)?, name: r.get(1)?, url: r.get(2)? }))?
                    .collect()
            })
            .map_err(|_| RestError::incomplete("Could not load stickers"))
    }
    pub fn save_sticker(&self, id: &str, name: &str, url: &str) -> Result<(), RestError> {
        if !public_image(url) || name.trim().is_empty() || name.len() > 100 {
            return Err(RestError::incomplete("Invalid sticker"));
        }
        self.store.read(|c|{let tx=c.unchecked_transaction()?;let count:i64=tx.query_row("SELECT count(*) FROM sticker_shelf WHERE url<>?1",[url],|r|r.get(0))?;if count>=200{return Err(rusqlite::Error::InvalidQuery)}tx.execute("INSERT INTO sticker_shelf(id,name,url) VALUES(?1,?2,?3) ON CONFLICT(url) DO UPDATE SET name=excluded.name",rusqlite::params![id,name.trim(),url])?;tx.commit()}).map_err(|_|RestError::incomplete("Could not save sticker"))
    }
    pub fn remove_sticker(&self, id: &str) -> Result<(), RestError> {
        self.store
            .read(|c| c.execute("DELETE FROM sticker_shelf WHERE id=?1", [id]).map(|_| ()))
            .map_err(|_| RestError::incomplete("Could not remove sticker"))
    }
    pub async fn send_sticker(
        &self,
        room: &str,
        name: &str,
        url: &str,
        operation: &str,
        root: Option<&str>,
    ) -> Result<(), RestError> {
        if !public_image(url) || !matches!(self.backend(), Backend::RocketChat) {
            return Err(RestError::incomplete("Invalid sticker"));
        }
        let mut message = json!({"_id":operation,"rid":room,"msg":"","attachments":[{"title":name,"image_url":url,"title_link":url}]});
        if let Some(root) = root {
            message["tmid"] = json!(root)
        }
        if let Err(error) = self.rest.post("chat.sendMessage", CallOptions::body(json!({"message":message}))).await {
            let confirmed = self.rest.get("chat.getMessage", CallOptions::params([("msgId", operation)])).await;
            let sent = confirmed.ok().and_then(|v| v.get("message").cloned()).is_some_and(|v| {
                v.get("_id").and_then(Value::as_str) == Some(operation)
                    && v.get("rid").and_then(Value::as_str) == Some(room)
                    && v.get("tmid").and_then(Value::as_str) == root
                    && v.get("u").and_then(|u| u.get("_id")).and_then(Value::as_str) == Some(self.info.user_id.as_str())
                    && v.get("attachments")
                        .and_then(Value::as_array)
                        .is_some_and(|a| a.iter().any(|a| a.get("image_url").and_then(Value::as_str) == Some(url)))
            });
            if !sent {
                return Err(error);
            }
        }
        Ok(())
    }
}
/// Public sticker/GIF bytes, without the chat account's credentials.
pub async fn image_bytes(url: &str) -> Result<Vec<u8>, String> {
    if !public_image(url) {
        return Err("Invalid image".into());
    }
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not load image")?;
    let mut response = http.get(url).send().await.map_err(|_| "Could not load image")?;
    if !response.status().is_success() {
        return Err("Could not load image".into());
    }
    let mut bytes = vec![];
    while let Some(chunk) = response.chunk().await.map_err(|_| "Could not load image")? {
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err("Image is too large".into());
        }
        bytes.extend_from_slice(&chunk)
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_accepts_only_safe_images() {
        let v = json!({"preview":{"items":[{"id":"1","type":"image","value":"https://media.giphy.com/a.gif"},{"id":"2","type":"image","value":"javascript:alert(1)"},{"id":"3","type":"text","value":"https://example.org/a"}]}});
        assert_eq!(previews(&v).len(), 1);
    }
}
