//! What a user can do to a message, and doing it. Rules port the Android
//! app's `lib/actionsMessage.ts`.

use serde_json::{Value, json};

use crate::rest::{CallOptions, RestClient, RestError};

/// The public settings the client acts on. Read with `count=0`: since 7.0
/// `settings.public` ignores `query` and pages by 50, so filtering is ours.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerSettings {
    pub editing_allowed: bool,
    pub edit_minutes: i64,
    pub deleting_allowed: bool,
    pub delete_minutes: i64,
    pub pinning_allowed: bool,
    /// `Site_Url`: the only base the server recognises in a quote permalink.
    pub site_url: Option<String>,
    pub max_file_size: Option<i64>,
    pub media_whitelist: Vec<String>,
}

impl ServerSettings {
    pub fn from_list(settings: &[Value]) -> Self {
        let get = |id: &str| {
            settings.iter().find(|s| s.get("_id").and_then(Value::as_str) == Some(id)).and_then(|s| s.get("value"))
        };
        let number = |id: &str| get(id).and_then(Value::as_i64).unwrap_or(0);
        ServerSettings {
            editing_allowed: get("Message_AllowEditing") != Some(&Value::Bool(false)),
            edit_minutes: number("Message_AllowEditing_BlockEditInMinutes"),
            deleting_allowed: get("Message_AllowDeleting") != Some(&Value::Bool(false)),
            delete_minutes: number("Message_AllowDeleting_BlockDeleteInMinutes"),
            pinning_allowed: get("Message_AllowPinning") != Some(&Value::Bool(false)),
            site_url: get("Site_Url").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned),
            max_file_size: get("FileUpload_MaxFileSize").and_then(Value::as_i64).filter(|n| *n > 0),
            media_whitelist: get("FileUpload_MediaTypeWhiteList")
                .and_then(Value::as_str)
                .map(|s| s.split(',').map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned).collect())
                .unwrap_or_default(),
        }
    }

    pub async fn fetch(rest: &RestClient) -> Self {
        let options = CallOptions { anonymous: true, ..CallOptions::params([("count", "0")]) };
        match rest.get("settings.public", options).await {
            Ok(v) => Self::from_list(v.get("settings").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])),
            Err(_) => Self::from_list(&[]),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    React,
    Reply,
    ReplyInThread,
    Copy,
    Download,
    Edit,
    Delete,
    Pin,
}

pub struct ActionContext<'a> {
    pub author_id: &'a str,
    pub ts: i64,
    pub system_type: Option<&'a str>,
    pub text: Option<&'a str>,
    pub has_file: bool,
    pub me: &'a str,
    pub settings: &'a ServerSettings,
    pub permissions: &'a [String],
    pub read_only: bool,
    pub encrypted: bool,
    pub in_thread: bool,
    pub now: i64,
}

fn within(ctx: &ActionContext, minutes: i64) -> bool {
    minutes <= 0 || ctx.now - ctx.ts <= minutes * 60_000
}

pub fn possible_actions(ctx: &ActionContext) -> Vec<Action> {
    let readable_encrypted = ctx.system_type == Some("e2e") && ctx.text.is_some();
    if ctx.system_type.is_some() && !readable_encrypted {
        return Vec::new();
    }
    let mut out = Vec::new();
    if !ctx.read_only {
        out.push(Action::React);
    }
    if !ctx.read_only && !ctx.encrypted {
        out.push(Action::Reply);
        if !ctx.in_thread {
            out.push(Action::ReplyInThread);
        }
    }
    if copyable_text(ctx.text).is_some() {
        out.push(Action::Copy);
    }
    if ctx.has_file {
        out.push(Action::Download);
    }
    let mine = ctx.author_id == ctx.me;
    let bypass = ctx.permissions.iter().any(|p| p == "bypass-time-limit-edit-and-delete");
    let may = |allowed: bool, minutes: i64| mine && allowed && (bypass || within(ctx, minutes));
    if !readable_encrypted
        && (may(ctx.settings.editing_allowed, ctx.settings.edit_minutes)
            || ctx.permissions.iter().any(|p| p == "edit-message"))
    {
        out.push(Action::Edit);
    }
    if may(ctx.settings.deleting_allowed, ctx.settings.delete_minutes)
        || ctx.permissions.iter().any(|p| p == "force-delete-message")
    {
        out.push(Action::Delete);
    }
    if ctx.settings.pinning_allowed {
        out.push(Action::Pin);
    }
    out
}

/// `/channel/<name>` (public), `/group/<name>` (private), `/direct/<rid>` (DM).
pub fn permalink(base: &str, kind: &str, name: Option<&str>, rid: &str, msg_id: &str) -> String {
    let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>().replace('+', "%20");
    let path = match kind {
        "c" => format!("channel/{}", enc(name.unwrap_or(rid))),
        "p" => format!("group/{}", enc(name.unwrap_or(rid))),
        _ => format!("direct/{}", enc(rid)),
    };
    format!("{}/{path}?msg={}", base.trim_end_matches('/'), enc(msg_id))
}

/// Rocket.Chat quotes by an invisible link before the reply.
pub fn quote(permalink: &str, text: &str) -> String {
    if text.is_empty() { format!("[ ]({permalink})") } else { format!("[ ]({permalink}) {text}") }
}

/// A reply's text without its leading quote links.
pub fn strip_quote_prefix(text: &str) -> &str {
    let mut rest = text;
    loop {
        let trimmed = rest.trim_start();
        let Some(after) = trimmed.strip_prefix("[ ](").or_else(|| trimmed.strip_prefix("[](")) else { return rest };
        let Some(end) = after.find(')') else { return rest };
        let link = &after[..end];
        if !(link.starts_with("http://") || link.starts_with("https://"))
            || !(link.contains("?msg=") || link.contains("&msg="))
        {
            return rest;
        }
        rest = after[end + 1..].trim_start();
    }
}

pub fn copyable_text(text: Option<&str>) -> Option<&str> {
    let words = strip_quote_prefix(text?).trim();
    (!words.is_empty()).then_some(words)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reaction {
    /// With colons, as the server keys it: `:+1:`.
    pub shortcode: String,
    pub count: usize,
    pub mine: bool,
}

/// `{":smile:": {"usernames": [...]}}`, in the server's order.
pub fn reactions(json: Option<&str>, me: &str) -> Vec<Reaction> {
    let Some(map) = json.and_then(|j| serde_json::from_str::<serde_json::Map<String, Value>>(j).ok()) else {
        return Vec::new();
    };
    map.into_iter()
        .filter_map(|(shortcode, v)| {
            let users: Vec<&str> = v.get("usernames")?.as_array()?.iter().filter_map(Value::as_str).collect();
            (!users.is_empty()).then(|| Reaction { mine: users.contains(&me), count: users.len(), shortcode })
        })
        .collect()
}

pub const QUICK_REACTIONS: [&str; 6] = [":+1:", ":heart:", ":joy:", ":tada:", ":open_mouth:", ":pray:"];

/// `shouldReact` makes the call idempotent: the server toggles otherwise.
pub async fn react(rest: &RestClient, msg_id: &str, shortcode: &str, add: bool) -> Result<(), RestError> {
    let body = json!({"messageId": msg_id, "emoji": shortcode, "shouldReact": add});
    rest.post("chat.react", CallOptions::body(body)).await.map(|_| ())
}

pub async fn edit(rest: &RestClient, rid: &str, msg_id: &str, text: &str) -> Result<Value, RestError> {
    let body = json!({"roomId": rid, "msgId": msg_id, "text": text});
    let response = rest.post("chat.update", CallOptions::body(body)).await?;
    Ok(response.get("message").cloned().unwrap_or(Value::Null))
}

/// Starts a call in the room; every member sees its message. Returns the `callId`.
pub async fn start_call(rest: &RestClient, rid: &str) -> Result<String, RestError> {
    let response = rest.post("video-conference.start", CallOptions::body(json!({"roomId": rid}))).await?;
    response
        .pointer("/data/callId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| RestError::incomplete("no callId"))
}

/// The provider's URL to join the call, token included when the server signs it.
pub async fn join_call(rest: &RestClient, call_id: &str) -> Result<String, RestError> {
    let response = rest.post("video-conference.join", CallOptions::body(json!({"callId": call_id}))).await?;
    response.get("url").and_then(Value::as_str).map(str::to_owned).ok_or_else(|| RestError::incomplete("no url"))
}

pub async fn delete(rest: &RestClient, rid: &str, msg_id: &str) -> Result<(), RestError> {
    rest.post("chat.delete", CallOptions::body(json!({"roomId": rid, "msgId": msg_id}))).await.map(|_| ())
}

pub async fn pin(rest: &RestClient, msg_id: &str) -> Result<(), RestError> {
    rest.post("chat.pinMessage", CallOptions::body(json!({"messageId": msg_id}))).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> ServerSettings {
        ServerSettings::from_list(&[
            json!({"_id": "Message_AllowEditing_BlockEditInMinutes", "value": 10}),
            json!({"_id": "Message_AllowDeleting_BlockDeleteInMinutes", "value": 0}),
            json!({"_id": "Site_Url", "value": "https://chat.example.com"}),
            json!({"_id": "FileUpload_MaxFileSize", "value": 1048576}),
            json!({"_id": "FileUpload_MediaTypeWhiteList", "value": "image/*, application/pdf"}),
        ])
    }

    fn ctx<'a>(s: &'a ServerSettings, perms: &'a [String], author: &'a str, age_min: i64) -> ActionContext<'a> {
        ActionContext {
            author_id: author,
            ts: 0,
            system_type: None,
            text: Some("hello"),
            has_file: false,
            me: "me",
            settings: s,
            permissions: perms,
            read_only: false,
            encrypted: false,
            in_thread: false,
            now: age_min * 60_000,
        }
    }

    #[test]
    fn settings_default_to_allowed() {
        let s = ServerSettings::from_list(&[]);
        assert!(s.editing_allowed && s.deleting_allowed && s.pinning_allowed);
        assert_eq!((s.edit_minutes, s.site_url, s.max_file_size), (0, None, None));
        let s = settings();
        assert_eq!(s.edit_minutes, 10);
        assert_eq!(s.max_file_size, Some(1048576));
        assert_eq!(s.media_whitelist, ["image/*", "application/pdf"]);
    }

    #[test]
    fn own_message_within_the_limit() {
        let s = settings();
        let none: Vec<String> = vec![];
        let fresh = possible_actions(&ctx(&s, &none, "me", 5));
        assert_eq!(
            fresh,
            [
                Action::React,
                Action::Reply,
                Action::ReplyInThread,
                Action::Copy,
                Action::Edit,
                Action::Delete,
                Action::Pin
            ]
        );
        let old = possible_actions(&ctx(&s, &none, "me", 30));
        assert!(!old.contains(&Action::Edit) && old.contains(&Action::Delete));
        let bypass = vec!["bypass-time-limit-edit-and-delete".to_owned()];
        assert!(possible_actions(&ctx(&s, &bypass, "me", 30)).contains(&Action::Edit));
    }

    #[test]
    fn others_messages_need_permissions() {
        let s = settings();
        let none: Vec<String> = vec![];
        let theirs = possible_actions(&ctx(&s, &none, "bob", 1));
        assert!(!theirs.contains(&Action::Edit) && !theirs.contains(&Action::Delete));
        let mods = vec!["edit-message".to_owned(), "force-delete-message".to_owned()];
        let moderated = possible_actions(&ctx(&s, &mods, "bob", 999));
        assert!(moderated.contains(&Action::Edit) && moderated.contains(&Action::Delete));
    }

    #[test]
    fn read_only_encrypted_threads_and_system_messages() {
        let s = settings();
        let none: Vec<String> = vec![];
        let mut c = ctx(&s, &none, "me", 1);
        c.read_only = true;
        assert!(!possible_actions(&c).iter().any(|a| matches!(a, Action::React | Action::Reply)));
        let mut c = ctx(&s, &none, "me", 1);
        c.in_thread = true;
        assert!(!possible_actions(&c).contains(&Action::ReplyInThread));
        let mut c = ctx(&s, &none, "me", 1);
        c.system_type = Some("uj");
        assert!(possible_actions(&c).is_empty());
    }

    #[test]
    fn permalinks_and_quotes() {
        let base = "https://chat.example.com/";
        assert_eq!(
            permalink(base, "c", Some("general"), "R1", "M1"),
            "https://chat.example.com/channel/general?msg=M1"
        );
        assert_eq!(
            permalink(base, "p", Some("my team"), "R1", "M1"),
            "https://chat.example.com/group/my%20team?msg=M1"
        );
        assert_eq!(permalink(base, "d", None, "R1", "M1"), "https://chat.example.com/direct/R1?msg=M1");
        let link = "https://chat.example.com/channel/general?msg=M1";
        assert_eq!(quote(link, "yes"), format!("[ ]({link}) yes"));
        assert_eq!(strip_quote_prefix(&quote(link, "yes")), "yes");
        assert_eq!(strip_quote_prefix(&format!("[ ]({link}) [ ]({link}) two")), "two");
        assert_eq!(strip_quote_prefix("[ ](https://ex.org/a) not a quote"), "[ ](https://ex.org/a) not a quote");
        assert_eq!(copyable_text(Some(&quote(link, ""))), None);
    }

    #[test]
    fn reactions_are_counted_and_mine_flagged() {
        let json = r#"{":+1:":{"usernames":["bob","me"]},":tada:":{"usernames":["bob"]},":x:":{"usernames":[]}}"#;
        let r = reactions(Some(json), "me");
        assert_eq!(r.len(), 2);
        assert_eq!(r[0], Reaction { shortcode: ":+1:".into(), count: 2, mine: true });
        assert!(!r[1].mine);
        assert!(reactions(None, "me").is_empty());
    }
}
