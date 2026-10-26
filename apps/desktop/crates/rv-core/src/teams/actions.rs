use serde_json::Value;

use super::auth::refusal;
use super::sync::TeamsSync;
use super::translate::split_id;
use crate::rest::RestError;

pub use rv_teams::service::{availability_presence, client_message_id, echoes, presence_availability, to_html};

impl TeamsSync {
    pub async fn send(&self, rid: &str, root: Option<&str>, text: &str, client_id: &str) -> Result<String, RestError> {
        self.service.send(rid, root, text, client_id).await
    }

    pub async fn set_typing(&self, rid: &str, active: bool) -> Result<(), RestError> {
        self.service.set_typing(rid, active).await
    }

    pub fn typing_event(&self, name: &str, resource: &Value) -> Option<(String, String, bool)> {
        let field = rv_teams::service::typing(name, resource)?;
        if field.from_mri == self.me() {
            return None;
        }
        let shown = field.display.unwrap_or_else(|| self.directory.shown(&field.from_mri));
        Some((field.rid, shown, field.active))
    }

    pub async fn edit(&self, msg_id: &str, text: &str) -> Result<(), RestError> {
        let text = match self.service.message(msg_id).await {
            Ok(Some((_, raw))) => rv_teams::translate::without_subject(&raw, text),
            _ => text.to_owned(),
        };
        self.service.edit(msg_id, &text).await?;
        self.refresh_one(msg_id).await;
        Ok(())
    }

    pub async fn delete(&self, msg_id: &str) -> Result<(), RestError> {
        self.service.delete(msg_id).await
    }

    pub async fn react(&self, msg_id: &str, shortcode: &str, add: bool) -> Result<(), RestError> {
        self.service.react(msg_id, shortcode, add).await?;
        self.refresh_one(msg_id).await;
        Ok(())
    }

    pub async fn set_pinned(&self, msg_id: &str, pinned: bool) -> Result<(), RestError> {
        let (rid, _) = split_id(msg_id).ok_or_else(|| refusal("message_id", 0))?;
        let team = self.team_of(rid).ok_or_else(|| refusal("pin_requires_channel", 0))?;
        self.service.set_pinned(&team, msg_id, pinned).await?;
        self.refresh_one(msg_id).await;
        Ok(())
    }

    pub async fn send_file(
        &self,
        rid: &str,
        root: Option<&str>,
        file: &super::sync::FileRef,
        caption: Option<&str>,
        client_id: &str,
    ) -> Result<(), RestError> {
        self.service.send_file(rid, root, file, caption, client_id).await
    }

    pub async fn mark_read(&self, rid: &str) -> Result<(), RestError> {
        let Some(newest) = self.unmarked_newest(rid) else { return Ok(()) };
        self.service.mark_read(rid, newest).await?;
        self.note_marked(rid, newest);
        Ok(())
    }

    pub async fn mine_since(&self, rid: &str, since: i64, client_id: &str) -> Result<(Option<Value>, bool), RestError> {
        self.service.mine_since(rid, since, client_id).await
    }

    async fn refresh_one(&self, msg_id: &str) {
        if let Ok(Some((rid, raw))) = self.service.message(msg_id).await {
            self.ingest_one(&rid, &raw);
        }
    }
}
