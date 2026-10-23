//! What I do in a Teams conversation: send, edit, delete, react, mark read.

use reqwest::Method;
use serde_json::{Value, json};

use super::auth::refusal;
use super::sync::TeamsSync;
use super::translate::{self, split_id};
use crate::rest::RestError;

/// The room, typist MRI, optional display name and active flag of a
/// Control/Typing push; None for any other resource.
struct TypingFields {
    rid: String,
    from_mri: String,
    display: Option<String>,
    active: bool,
}

fn typing_fields(name: &str, resource: &Value) -> Option<TypingFields> {
    if name != "NewMessage" {
        return None;
    }
    let active = match resource.get("messagetype").and_then(Value::as_str)? {
        "Control/Typing" => true,
        "Control/ClearTyping" => false,
        _ => return None,
    };
    let rid = translate::conversation_of(resource)?;
    let from_mri = translate::mri_of(resource.get("from").and_then(Value::as_str).unwrap_or_default()).to_owned();
    let display = resource.get("imdisplayname").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    Some(TypingFields { rid, from_mri, display, active })
}

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
    /// Sends `text`, a reply to `root` in a channel when given, with my
    /// `client_id` for the conversation to echo; answers the server id it minted.
    pub async fn send(&self, rid: &str, root: Option<&str>, text: &str, client_id: &str) -> Result<String, RestError> {
        let body = json!({
            "content": to_html(text),
            "messagetype": "RichText/Html",
            "contenttype": "text",
            "clientmessageid": client_id,
            "imdisplayname": self.directory.shown(self.me()),
        });
        let target = thread_target(rid, root);
        let url = self.conversation_url(&target, &["messages"], "").await?;
        let answer = self.chat(Method::POST, url, Some(&body)).await?;
        let id = translate::int_of(&answer.body, "OriginalArrivalTime")
            .ok_or_else(|| refusal("send_answer", answer.status))?;
        Ok(id.to_string())
    }

    /// Tells the conversation I am typing, or stopped; best effort.
    pub async fn set_typing(&self, rid: &str, active: bool) -> Result<(), RestError> {
        let body = json!({
            "content": "",
            "messagetype": if active { "Control/Typing" } else { "Control/ClearTyping" },
            "contenttype": "Application/Message",
            "imdisplayname": self.directory.shown(self.me()),
        });
        let url = self.conversation_url(rid, &["messages"], "").await?;
        self.chat(Method::POST, url, Some(&body)).await?;
        Ok(())
    }

    /// A Control/Typing push, as (room, typist display name, active); None for
    /// my own typing or any other resource.
    pub fn typing_event(&self, name: &str, resource: &Value) -> Option<(String, String, bool)> {
        let field = typing_fields(name, resource)?;
        if field.from_mri == self.me() {
            return None;
        }
        let shown = field.display.unwrap_or_else(|| self.directory.shown(&field.from_mri));
        Some((field.rid, shown, field.active))
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

    /// Pins or unpins a channel post through the CSA aggregator, then re-reads
    /// the message so its `pinned` property (and our flag) refreshes. Teams
    /// scopes a channel pin under its parent team, so this is channel-only; a
    /// chat (group or 1:1) has no team here and is refused.
    pub async fn set_pinned(&self, msg_id: &str, pinned: bool) -> Result<(), RestError> {
        let (rid, post) = ids(msg_id)?;
        let team = self.team_of(rid).ok_or_else(|| refusal("pin_requires_channel", 0))?;
        let method = if pinned { Method::POST } else { Method::DELETE };
        let segments = ["api", "v1", "teams", team.as_str(), "channels", rid, "posts", post, "pin"];
        self.aggregator_call(method, &segments, "", None).await?;
        self.refresh_one(msg_id).await;
        Ok(())
    }

    /// Posts a file message to a channel: the uploaded file as `properties.files`
    /// (the shape the chat service stores and our `file_attachments` reads back),
    /// an optional caption as the content, with a stable client id for dedup.
    pub async fn send_file(
        &self,
        rid: &str,
        root: Option<&str>,
        file: &super::sync::FileRef,
        caption: Option<&str>,
        client_id: &str,
    ) -> Result<(), RestError> {
        let ext = file.name.rsplit('.').next().filter(|e| *e != file.name).unwrap_or("");
        let files = serde_json::to_string(&json!([{
            "@type": "http://schema.skype.com/File",
            "version": 2,
            "id": file.unique,
            "itemid": file.unique,
            "fileName": file.name,
            "fileType": ext,
            "title": file.name,
            "type": ext,
            "state": "active",
            "fileInfo": {"fileUrl": file.web_url, "siteUrl": file.site, "serverRelativeUrl": "", "itemId": null, "shareUrl": null, "shareId": null},
            "fileChicletState": {"serviceName": "teams", "state": "active"},
            "baseUrl": file.site,
            "objectUrl": file.web_url,
        }]))
        .unwrap_or_default();
        let content = caption.filter(|c| !c.is_empty()).map(to_html).unwrap_or_default();
        let body = json!({
            "content": content,
            "messagetype": "RichText/Html",
            "contenttype": "Text",
            "clientmessageid": client_id,
            "imdisplayname": self.directory.shown(self.me()),
            "properties": {"files": files},
        });
        let target = thread_target(rid, root);
        let url = self.conversation_url(&target, &["messages"], "").await?;
        self.chat(Method::POST, url, Some(&body)).await?;
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

    /// My message carrying `client_id`, among those that arrived since
    /// `since`; and whether the page was full, so absence proves nothing.
    pub async fn mine_since(&self, rid: &str, since: i64, client_id: &str) -> Result<(Option<Value>, bool), RestError> {
        let query = format!("view=msnp24Equivalent|supportsMessageProperties&pageSize=200&startTime={}", since.max(0));
        let url = self.conversation_url(rid, &["messages"], &query).await?;
        let body = self.chat(Method::GET, url, None).await?.body;
        let messages = body.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
        let full = messages.len() >= 200;
        let me = self.me().to_owned();
        let found = messages
            .into_iter()
            .find(|m| echoes(m, client_id) && translate::str_of(m, "from").is_some_and(|f| translate::mri_of(f) == me));
        Ok((found, full))
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

/// The conversation a message goes to: a channel reply names its root.
fn thread_target(rid: &str, root: Option<&str>) -> String {
    match root.and_then(split_id) {
        Some((_, root)) => format!("{rid};messageid={root}"),
        None => rid.to_owned(),
    }
}

/// The client id a queued row is sent with: digits, like Teams' own, and the same on every try.
pub fn client_message_id(entry_id: &str) -> String {
    let digits: String = entry_id.chars().filter(char::is_ascii_hexdigit).take(15).collect();
    u64::from_str_radix(&digits, 16).map(|n| n.to_string()).unwrap_or_else(|_| entry_id.to_owned())
}

/// Whether a stored message carries the client id a send gave it.
pub fn echoes(raw: &Value, client_id: &str) -> bool {
    translate::str_of(raw, "clientmessageid") == Some(client_id)
}

/// Teams availability onto the app's presence.
pub fn availability_presence(availability: &str) -> crate::live::Presence {
    use crate::live::Presence;
    match availability {
        "Available" | "AvailableIdle" => Presence::Online,
        "Away" | "BeRightBack" => Presence::Away,
        "Busy" | "BusyIdle" | "DoNotDisturb" | "InAMeeting" | "InACall" | "Presenting" | "Focusing" => Presence::Busy,
        _ => Presence::Offline,
    }
}

/// The Teams availability to set for one of the app's presences.
pub fn presence_availability(p: crate::live::Presence) -> &'static str {
    use crate::live::Presence;
    match p {
        Presence::Online => "Available",
        Presence::Away => "Away",
        Presence::Busy => "DoNotDisturb",
        Presence::Offline => "Offline",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn availability_maps_onto_presence() {
        use crate::live::Presence;
        assert_eq!(availability_presence("Available"), Presence::Online);
        assert_eq!(availability_presence("Away"), Presence::Away);
        assert_eq!(availability_presence("BeRightBack"), Presence::Away);
        assert_eq!(availability_presence("DoNotDisturb"), Presence::Busy);
        assert_eq!(availability_presence("InAMeeting"), Presence::Busy);
        assert_eq!(availability_presence("Offline"), Presence::Offline);
        assert_eq!(availability_presence("PresenceUnknown"), Presence::Offline);
        assert_eq!(presence_availability(Presence::Online), "Available");
        assert_eq!(presence_availability(Presence::Busy), "DoNotDisturb");
    }

    #[test]
    fn client_ids_are_stable_digits() {
        let id = client_message_id("65f0a1b2c3d4e5f6a7b8c9d0");
        assert!(id.bytes().all(|b| b.is_ascii_digit()));
        assert_eq!(id, client_message_id("65f0a1b2c3d4e5f6a7b8c9d0"));
        assert_eq!(thread_target("19:c@thread.tacv2", Some("19:c@thread.tacv2/10")), "19:c@thread.tacv2;messageid=10");
        assert_eq!(thread_target("19:c@thread.v2", None), "19:c@thread.v2");
    }

    #[test]
    fn a_control_typing_push_is_detected_with_its_room_and_typist() {
        let resource = json!({
            "messagetype": "Control/Typing",
            "from": "https://x/v1/users/ME/contacts/8:orgid:ada",
            "imdisplayname": "Ada",
            "conversationLink": "https://x/v1/users/ME/conversations/19:c@thread.v2"
        });
        let f = typing_fields("NewMessage", &resource).expect("typing");
        assert_eq!(f.rid, "19:c@thread.v2");
        assert_eq!(f.from_mri, "8:orgid:ada");
        assert_eq!(f.display.as_deref(), Some("Ada"));
        assert!(f.active);
        let mut clear = resource.clone();
        clear["messagetype"] = json!("Control/ClearTyping");
        assert!(!typing_fields("NewMessage", &clear).unwrap().active);
        // An ordinary message is not typing.
        let mut msg = resource.clone();
        msg["messagetype"] = json!("RichText/Html");
        assert!(typing_fields("NewMessage", &msg).is_none());
        // Only NewMessage carries typing.
        assert!(typing_fields("MessageUpdate", &resource).is_none());
    }

    #[test]
    fn typed_text_is_escaped_html() {
        assert_eq!(to_html("a <b> & \"c\"\nnext"), "<p>a &lt;b&gt; &amp; &quot;c&quot;</p><p>next</p>");
        assert_eq!(to_html(""), "<p></p>");
    }
}
