//! What a user can do to a message, and doing it. Rules port the Android
//! app's `lib/messageActions.ts`.

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
    pub starring_allowed: bool,
    /// `Site_Url`: the only base the server recognises in a quote permalink.
    pub site_url: Option<String>,
    pub max_file_size: Option<i64>,
    pub media_whitelist: Vec<String>,
    /// `E2E_Enable_Encrypt_Files`: without it an encrypted room takes no file.
    pub encrypted_files: bool,
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
            starring_allowed: get("Message_AllowStarring") != Some(&Value::Bool(false)),
            site_url: get("Site_Url").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned),
            max_file_size: get("FileUpload_MaxFileSize").and_then(Value::as_i64).filter(|n| *n > 0),
            media_whitelist: get("FileUpload_MediaTypeWhiteList")
                .and_then(Value::as_str)
                .map(|s| s.split(',').map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned).collect())
                .unwrap_or_default(),
            encrypted_files: get("E2E_Enable_Encrypt_Files") == Some(&Value::Bool(true)),
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
    Unpin,
    Star,
    Unstar,
}

pub struct ActionContext<'a> {
    pub author_id: &'a str,
    pub ts: i64,
    pub system_type: Option<&'a str>,
    pub text: Option<&'a str>,
    pub has_file: bool,
    pub me: &'a str,
    pub settings: &'a ServerSettings,
    /// Those I hold in the room; None when they could not be read.
    pub permissions: Option<&'a [String]>,
    pub read_only: bool,
    pub encrypted: bool,
    pub in_thread: bool,
    pub pinned: bool,
    /// I starred it.
    pub starred: bool,
    pub now: i64,
    /// Still in the outbox (`pending` or `failed`): the server does not have it.
    pub outbox: Option<&'a str>,
}

fn within(ctx: &ActionContext, minutes: i64) -> bool {
    minutes <= 0 || ctx.now - ctx.ts <= minutes * 60_000
}

/// System messages (joins, calls…) and encrypted ones not read yet offer nothing.
pub fn has_actions(system_type: Option<&str>, text: Option<&str>) -> bool {
    match system_type {
        None => true,
        Some("e2e") => text.is_some(),
        Some(_) => false,
    }
}

pub fn possible_actions(ctx: &ActionContext) -> Vec<Action> {
    if !has_actions(ctx.system_type, ctx.text) {
        return Vec::new();
    }
    if let Some(status) = ctx.outbox {
        let mut out = Vec::new();
        if copyable_text(ctx.text).is_some() {
            out.push(Action::Copy);
        }
        if status == "failed" {
            out.push(Action::Delete);
        }
        return out;
    }
    let mut out = Vec::new();
    if !ctx.read_only {
        out.push(Action::React);
    }
    // A quote is a card the server builds from the text, which it cannot
    // read in an encrypted room: there, one answers in a thread.
    if !ctx.read_only {
        if !ctx.encrypted {
            out.push(Action::Reply);
        }
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
    // The server's own checks (8.5 updateMessage, canDeleteMessageAsync, pinMessage).
    // Unknown permissions (the server could not be asked): what a member may do
    // on their own messages, and Pin; the server decides.
    let has = |permission: &str, if_unknown: bool| {
        ctx.permissions.map_or(if_unknown, |granted| granted.iter().any(|p| p == permission))
    };
    let no_limit = has("bypass-time-limit-edit-and-delete", false);
    if (has("edit-message", false) || (mine && ctx.settings.editing_allowed))
        && (no_limit || within(ctx, ctx.settings.edit_minutes))
    {
        out.push(Action::Edit);
    }
    if has("force-delete-message", false)
        || (ctx.settings.deleting_allowed
            && (has("delete-message", false) || (mine && has("delete-own-message", true)))
            && (no_limit || within(ctx, ctx.settings.delete_minutes)))
    {
        out.push(Action::Delete);
    }
    if ctx.settings.pinning_allowed && has("pin-message", true) {
        out.push(if ctx.pinned { Action::Unpin } else { Action::Pin });
    }
    if ctx.settings.starring_allowed {
        out.push(if ctx.starred { Action::Unstar } else { Action::Star });
    }
    out
}

/// A permission and the roles that hold it.
pub type PermissionRoles = (String, Vec<String>);

/// Each permission `permissions.listAll` lists with its roles: the message
/// actions' and the slash commands'.
pub fn permission_roles(response: &Value) -> Vec<PermissionRoles> {
    let list = response.get("update").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    list.iter()
        .filter_map(|p| {
            let id = p.get("_id").and_then(Value::as_str)?;
            let roles = p.get("roles").and_then(Value::as_array)?;
            Some((id.to_owned(), roles.iter().filter_map(Value::as_str).map(str::to_owned).collect()))
        })
        .collect()
}

/// Those granted to someone holding `roles` (global and in the room).
pub fn granted(permissions: &[PermissionRoles], roles: &[String]) -> Vec<String> {
    permissions
        .iter()
        .filter(|(_, needed)| needed.iter().any(|r| roles.contains(r)))
        .map(|(id, _)| id.clone())
        .collect()
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
/// Whether a message can be forwarded to another room: where it can be
/// quoted (Reply, never in an encrypted room), and an ordinary message
/// already on the server (no system line, nothing still in the outbox).
pub fn forwardable(allowed: &[Action], system_type: Option<&str>, pending: bool) -> bool {
    allowed.contains(&Action::Reply) && system_type.is_none() && !pending
}

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

/// What the room list previews of a last message: its own words after any
/// quote links, or None for a quote with no words of its own (a forward),
/// which the list names as one. Text that starts with no quote stays whole.
pub fn preview_words(text: &str) -> Option<&str> {
    let own = strip_quote_prefix(text);
    if own.len() == text.len() {
        return Some(text);
    }
    let own = own.trim();
    (!own.is_empty()).then_some(own)
}

/// How many days a new invite link lives: one of the values the server
/// accepts (0 for never, 1, 7, 15, 30).
pub const INVITE_DAYS: u32 = 7;

/// The permission that lets someone create a room's invite links (admins,
/// owners and moderators by default).
pub const INVITE_PERMISSION: &str = "create-invite-links";
/// Writing in a read-only room (owners and moderators by default).
pub const POST_READONLY_PERMISSION: &str = "post-readonly";

/// The direct invite link, served by the server itself: never the answer's
/// `url`, which goes through `go.rocket.chat` unless the workspace says otherwise.
pub fn invite_link(site_url: &str, id: &str) -> String {
    let id = url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>().replace('+', "%20");
    format!("{}/invite/{id}", site_url.trim_end_matches('/'))
}

/// The longest name suggested for a discussion.
pub const DISCUSSION_NAME_MAX: usize = 60;

/// A message's first non-empty line (its quote links left out), shortened:
/// the name suggested for the discussion it starts.
pub fn suggested_discussion_name(text: Option<&str>) -> String {
    let words = strip_quote_prefix(text.unwrap_or_default());
    let line = words.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
    if line.chars().count() > DISCUSSION_NAME_MAX {
        let cut: String = line.chars().take(DISCUSSION_NAME_MAX - 1).collect();
        format!("{}…", cut.trim_end())
    } else {
        line.to_owned()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reaction {
    /// With colons, as the server keys it: `:+1:`.
    pub shortcode: String,
    pub count: usize,
    pub mine: bool,
    /// Who reacted, in the server's order: each username with the name the
    /// row stored beside it (Rocket.Chat's `names` when it shows real names,
    /// a WhatsApp contact's name), empty when none.
    pub people: Vec<(String, String)>,
}

/// `{":smile:": {"usernames": [...], "names": [...]}}`, in the server's order.
pub fn reactions(json: Option<&str>, me: &str) -> Vec<Reaction> {
    let Some(map) = json.and_then(|j| serde_json::from_str::<serde_json::Map<String, Value>>(j).ok()) else {
        return Vec::new();
    };
    map.into_iter()
        .filter_map(|(shortcode, v)| {
            // Paired by position, so one odd entry does not shift the names after it.
            let names = v.get("names").and_then(Value::as_array);
            let people: Vec<(String, String)> = v
                .get("usernames")?
                .as_array()?
                .iter()
                .enumerate()
                .filter_map(|(i, user)| {
                    let name = names.and_then(|n| n.get(i)).and_then(Value::as_str).unwrap_or_default();
                    Some((user.as_str()?.to_owned(), name.to_owned()))
                })
                .collect();
            (!people.is_empty()).then(|| Reaction {
                mine: people.iter().any(|(user, _)| user == me),
                count: people.len(),
                shortcode,
                people,
            })
        })
        .collect()
}

/// How many people a reaction's hover text names before "and N others".
pub const REACTORS_SHOWN: usize = 12;

/// What hovering a reaction chip shows: its code, then who reacted, me first
/// as "You", the others as `name(username, stored name)` says, those past
/// `REACTORS_SHOWN` only counted.
pub fn reactors_text(reaction: &Reaction, me: &str, name: impl Fn(&str, &str) -> String) -> String {
    let mut shown: Vec<String> = Vec::new();
    if reaction.mine {
        shown.push(crate::i18n::t("reactions.you").to_owned());
    }
    let others: Vec<&(String, String)> = reaction.people.iter().filter(|(user, _)| user != me).collect();
    let room = REACTORS_SHOWN - shown.len();
    shown.extend(others.iter().take(room).map(|(user, stored)| name(user, stored)));
    let rest = others.len().saturating_sub(room);
    let people = if rest > 0 {
        crate::i18n::tn("receipts.and_others", rest as i64).replace("{names}", &shown.join(", "))
    } else if let [first @ .., last] = shown.as_slice()
        && !first.is_empty()
    {
        crate::i18n::tf("reactions.and", &[("first", &first.join(", ")), ("last", last)])
    } else {
        shown.concat()
    };
    format!("{}\n{people}", reaction.shortcode)
}

/// A reactor as the row names them: the name stored beside the username, else the username.
pub fn stored_reactor(username: &str, stored: &str) -> String {
    if stored.is_empty() { username.to_owned() } else { stored.to_owned() }
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

/// An encrypted message is edited through `content`, which the server takes
/// only on an `e2e` message, and would refuse `text` there.
pub async fn edit_encrypted(
    rest: &RestClient,
    rid: &str,
    msg_id: &str,
    content: Value,
    mentions: Value,
) -> Result<Value, RestError> {
    let body = json!({"roomId": rid, "msgId": msg_id, "content": content, "e2eMentions": mentions});
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

/// The call's own address (`video-conference.info`), when the provider gives one.
pub async fn call_url(rest: &RestClient, call_id: &str) -> Result<Option<String>, RestError> {
    let response = rest.get("video-conference.info", CallOptions::params([("callId", call_id)])).await?;
    Ok(response.get("url").and_then(Value::as_str).filter(|u| !u.is_empty()).map(str::to_owned))
}

/// Declines a ringing call; only Rocket.Chat's licensed direct calls accept it.
pub async fn cancel_call(rest: &RestClient, call_id: &str) -> Result<(), RestError> {
    rest.post("video-conference.cancel", CallOptions::body(json!({"callId": call_id}))).await.map(|_| ())
}

pub async fn delete(rest: &RestClient, rid: &str, msg_id: &str) -> Result<(), RestError> {
    rest.post("chat.delete", CallOptions::body(json!({"roomId": rid, "msgId": msg_id}))).await.map(|_| ())
}

pub async fn favorite(rest: &RestClient, rid: &str, on: bool) -> Result<(), RestError> {
    rest.post("rooms.favorite", CallOptions::body(json!({"roomId": rid, "favorite": on}))).await.map(|_| ())
}

/// The answer of `subscriptions.unread` in a room with no message to mark.
pub const NOTHING_TO_UNREAD: &str = "error-no-message-for-unread";

/// Makes the room unread from its last message (`subscriptions.unread`): the
/// server sets my subscription's `unread` to 1, `alert`, and `ls` just
/// before that message, then broadcasts it on `subscriptions-changed`. A room
/// with no message answers 400 [`NOTHING_TO_UNREAD`].
pub async fn mark_unread(rest: &RestClient, rid: &str) -> Result<(), RestError> {
    let options = CallOptions { retry_on_network_error: true, ..CallOptions::body(json!({"roomId": rid})) };
    rest.post("subscriptions.unread", options).await.map(|_| ())
}

/// Marks the whole room read, its threads too (`readThreads`): without it a
/// room with an unread thread keeps `alert` and stays in Unread (probed on 8.5.1).
pub async fn mark_read(rest: &RestClient, rid: &str) -> Result<(), RestError> {
    let options =
        CallOptions { retry_on_network_error: true, ..CallOptions::body(json!({"rid": rid, "readThreads": true})) };
    rest.post("subscriptions.read", options).await.map(|_| ())
}

/// The levels a room's own notifications take (`rooms.saveNotification`
/// refuses anything else with `error-invalid-settings`).
pub const ROOM_NOTIFICATION_LEVELS: [&str; 4] = ["default", "all", "mentions", "nothing"];

/// A room's own notifications, desktop and push together (`default` hands
/// them back to the account's preference). `lift_silence` also clears the
/// `disableNotifications` another client set, which would keep the room quiet
/// whatever is chosen.
pub async fn room_notifications(
    rest: &RestClient,
    rid: &str,
    level: &str,
    lift_silence: bool,
) -> Result<(), RestError> {
    if !ROOM_NOTIFICATION_LEVELS.contains(&level) {
        return Err(RestError::incomplete("room notifications: unknown level"));
    }
    let mut notifications = json!({"desktopNotifications": level, "mobilePushNotifications": level});
    if lift_silence {
        notifications["disableNotifications"] = json!("0");
    }
    let body = json!({"roomId": rid, "notifications": notifications});
    rest.post("rooms.saveNotification", CallOptions::body(body)).await.map(|_| ())
}

pub async fn pin(rest: &RestClient, msg_id: &str) -> Result<(), RestError> {
    rest.post("chat.pinMessage", CallOptions::body(json!({"messageId": msg_id}))).await.map(|_| ())
}

pub async fn unpin(rest: &RestClient, msg_id: &str) -> Result<(), RestError> {
    rest.post("chat.unPinMessage", CallOptions::body(json!({"messageId": msg_id}))).await.map(|_| ())
}

pub async fn star(rest: &RestClient, msg_id: &str, on: bool) -> Result<(), RestError> {
    let endpoint = if on { "chat.starMessage" } else { "chat.unStarMessage" };
    rest.post(endpoint, CallOptions::body(json!({"messageId": msg_id}))).await.map(|_| ())
}

/// A room's pinned messages (`chat.getPinnedMessages`) or my starred ones
/// (`chat.getStarredMessages`), newest first, as the server sends them.
pub async fn marked(rest: &RestClient, rid: &str, starred: bool) -> Result<Vec<Value>, RestError> {
    let endpoint = if starred { "chat.getStarredMessages" } else { "chat.getPinnedMessages" };
    let response = rest.get(endpoint, CallOptions::params([("roomId", rid), ("count", "50")])).await?;
    Ok(response.get("messages").and_then(Value::as_array).cloned().unwrap_or_default())
}

/// Follows a thread (`chat.followMessage`) or stops (`chat.unfollowMessage`):
/// idempotent; the server then rebroadcasts the root with its `replies`.
pub async fn follow_thread(rest: &RestClient, root: &str, on: bool) -> Result<(), RestError> {
    let endpoint = if on { "chat.followMessage" } else { "chat.unfollowMessage" };
    let options = CallOptions { retry_on_network_error: true, ..CallOptions::body(json!({"mid": root})) };
    rest.post(endpoint, options).await.map(|_| ())
}

/// One page of a room's thread roots (`chat.getThreadsList`), the most
/// recently answered first, with the total: every thread, or the ones I follow.
pub async fn threads(
    rest: &RestClient,
    rid: &str,
    following: bool,
    offset: u32,
    count: u32,
) -> Result<(Vec<Value>, u32), RestError> {
    let (offset, count) = (offset.to_string(), count.to_string());
    let mut params = vec![("rid", rid), ("offset", offset.as_str()), ("count", count.as_str())];
    if following {
        params.push(("type", "following"));
    }
    let response = rest.get("chat.getThreadsList", CallOptions::params(params)).await?;
    let threads = response.get("threads").and_then(Value::as_array).cloned().unwrap_or_default();
    let total = response.get("total").and_then(Value::as_u64).map_or(threads.len() as u32, |t| t as u32);
    Ok((threads, total))
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
            permissions: Some(perms),
            read_only: false,
            encrypted: false,
            in_thread: false,
            pinned: false,
            starred: false,
            now: age_min * 60_000,
            outbox: None,
        }
    }

    #[test]
    fn an_unsent_message_offers_only_local_actions() {
        let s = settings();
        let perms = vec!["edit-message".to_owned(), "delete-message".to_owned(), "pin-message".to_owned()];
        let mut failed = ctx(&s, &perms, "me", 0);
        failed.outbox = Some("failed");
        assert_eq!(possible_actions(&failed), vec![Action::Copy, Action::Delete]);
        let mut pending = ctx(&s, &perms, "me", 0);
        pending.outbox = Some("pending");
        assert_eq!(possible_actions(&pending), vec![Action::Copy]);
    }

    #[test]
    fn settings_default_to_allowed() {
        let s = ServerSettings::from_list(&[]);
        assert!(s.editing_allowed && s.deleting_allowed && s.pinning_allowed && s.starring_allowed);
        assert_eq!((s.edit_minutes, s.site_url, s.max_file_size), (0, None, None));
        let s = settings();
        assert_eq!(s.edit_minutes, 10);
        assert_eq!(s.max_file_size, Some(1048576));
        assert_eq!(s.media_whitelist, ["image/*", "application/pdf"]);
    }

    #[test]
    fn own_message_within_the_limit() {
        let s = settings();
        let pin = vec!["pin-message".to_owned(), "delete-own-message".to_owned()];
        let fresh = possible_actions(&ctx(&s, &pin, "me", 5));
        assert_eq!(
            fresh,
            [
                Action::React,
                Action::Reply,
                Action::ReplyInThread,
                Action::Copy,
                Action::Edit,
                Action::Delete,
                Action::Pin,
                Action::Star
            ]
        );
        let own = vec!["delete-own-message".to_owned()];
        let old = possible_actions(&ctx(&s, &own, "me", 30));
        assert!(!old.contains(&Action::Edit) && old.contains(&Action::Delete));
        let bypass = vec!["bypass-time-limit-edit-and-delete".to_owned()];
        assert!(possible_actions(&ctx(&s, &bypass, "me", 30)).contains(&Action::Edit));
    }

    #[test]
    fn system_messages_have_no_actions() {
        assert!(has_actions(None, Some("hi")));
        assert!(!has_actions(Some("uj"), None));
        assert!(!has_actions(Some("videoconf"), None));
        assert!(!has_actions(Some("e2e"), None));
        assert!(has_actions(Some("e2e"), Some("clear")));
    }

    #[test]
    fn others_messages_need_permissions() {
        let s = settings();
        let none: Vec<String> = vec![];
        let theirs = possible_actions(&ctx(&s, &none, "bob", 1));
        assert!(!theirs.contains(&Action::Edit) && !theirs.contains(&Action::Delete));
        let mods = vec![
            "edit-message".to_owned(),
            "force-delete-message".to_owned(),
            "bypass-time-limit-edit-and-delete".to_owned(),
        ];
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
    fn encrypted_rooms_answer_in_threads_and_edit() {
        let s = settings();
        let none: Vec<String> = vec![];
        let mut c = ctx(&s, &none, "me", 1);
        c.encrypted = true;
        c.system_type = Some("e2e");
        let actions = possible_actions(&c);
        assert!(actions.contains(&Action::ReplyInThread) && actions.contains(&Action::Edit));
        assert!(!actions.contains(&Action::Reply));
        c.text = None;
        assert!(possible_actions(&c).is_empty());
    }

    #[test]
    fn forwarding_follows_quoting() {
        assert!(forwardable(&[Action::React, Action::Reply], None, false));
        assert!(!forwardable(&[Action::React, Action::ReplyInThread], None, false), "encrypted or read-only");
        assert!(!forwardable(&[Action::Reply], Some("uj"), false));
        assert!(!forwardable(&[Action::Reply], None, true), "not on the server yet");
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
    fn previews_read_a_quote_by_its_own_words() {
        let link = "https://chat.example.com/channel/general?msg=M1";
        assert_eq!(preview_words(&quote(link, "yes")), Some("yes"));
        assert_eq!(preview_words(&format!("[ ]({link}) [ ]({link}) two")), Some("two"));
        assert_eq!(preview_words(&quote(link, "")), None, "a forward");
        assert_eq!(preview_words(&format!("[ ]({link})  \n ")), None);
        assert_eq!(preview_words("  plain "), Some("  plain "), "no quote: untouched");
        assert_eq!(preview_words("[ ](https://ex.org/a) x"), Some("[ ](https://ex.org/a) x"));
    }

    #[test]
    fn invite_links_are_direct() {
        assert_eq!(invite_link("https://chat.example.com/", "aB3dE9"), "https://chat.example.com/invite/aB3dE9");
        assert_eq!(invite_link("http://localhost:3000", "a b"), "http://localhost:3000/invite/a%20b");
    }

    #[test]
    fn a_discussion_is_named_after_its_message() {
        assert_eq!(suggested_discussion_name(Some("\n  first line \nsecond")), "first line");
        assert_eq!(suggested_discussion_name(None), "");
        let link = "https://chat.example.com/channel/general?msg=M1";
        assert_eq!(suggested_discussion_name(Some(&quote(link, "quoted words"))), "quoted words");
        let long = "é".repeat(80);
        let name = suggested_discussion_name(Some(&long));
        assert_eq!(name.chars().count(), DISCUSSION_NAME_MAX);
        assert!(name.ends_with('…'));
    }

    #[test]
    fn reactions_are_counted_and_mine_flagged() {
        let json = r#"{":+1:":{"usernames":["bob","me"]},":tada:":{"usernames":["bob"]},":x:":{"usernames":[]}}"#;
        let r = reactions(Some(json), "me");
        assert_eq!(r.len(), 2);
        let people = vec![("bob".to_owned(), String::new()), ("me".to_owned(), String::new())];
        assert_eq!(r[0], Reaction { shortcode: ":+1:".into(), count: 2, mine: true, people });
        assert!(!r[1].mine);
        assert!(reactions(None, "me").is_empty());
    }

    #[test]
    fn a_reaction_names_who_reacted_me_first() {
        let _serial = crate::i18n::LANGUAGE.lock().unwrap();
        crate::i18n::set(crate::i18n::Lang::En);
        let json =
            r#"{":+1:":{"usernames":["bob","me","ann"],"names":["Bob B","Me M","Ann A"]},":x:":{"usernames":["bob"]}}"#;
        let r = reactions(Some(json), "me");
        assert_eq!(r[0].people[2], ("ann".to_owned(), "Ann A".to_owned()));
        assert_eq!(reactors_text(&r[0], "me", stored_reactor), ":+1:\nYou, Bob B and Ann A");
        assert_eq!(reactors_text(&r[1], "me", stored_reactor), ":x:\nbob");
        let crowd = |n: usize, me_too: bool| {
            let mut users: Vec<String> = (0..n).map(|i| format!("u{i}")).collect();
            if me_too {
                users.push("me".into());
            }
            let r = reactions(Some(&serde_json::json!({":tada:": {"usernames": users}}).to_string()), "me");
            reactors_text(&r[0], "me", stored_reactor)
        };
        assert!(crowd(15, false).ends_with("u10, u11 and 3 others"), "{}", crowd(15, false));
        assert!(crowd(12, false).ends_with("u10 and u11"), "{}", crowd(12, false));
        assert!(crowd(13, false).ends_with("u11 and 1 other"), "{}", crowd(13, false));
        let mine = crowd(12, true);
        assert!(mine.starts_with(":tada:\nYou, u0,") && mine.ends_with("u10 and 1 other"), "{mine}");
        crate::i18n::set(crate::i18n::Lang::Fr);
        assert_eq!(reactors_text(&r[0], "me", stored_reactor), ":+1:\nVous, Bob B et Ann A");
        crate::i18n::set(crate::i18n::Lang::En);
    }

    #[test]
    fn reactor_names_pair_with_usernames_by_position() {
        let json =
            r#"{":+1:":{"usernames":["bob",7,"carol"],"names":["B",null,"C"]},":x:":{"usernames":["ann"],"names":[]}}"#;
        let r = reactions(Some(json), "me");
        assert_eq!(r[0].people, vec![("bob".to_owned(), "B".to_owned()), ("carol".to_owned(), "C".to_owned())]);
        assert_eq!(r[1].people, vec![("ann".to_owned(), String::new())]);
    }

    #[test]
    fn pinned_and_starred_offer_the_way_back() {
        let s = settings();
        let none: Vec<String> = vec![];
        let pin = vec!["pin-message".to_owned()];
        let mut c = ctx(&s, &pin, "bob", 1);
        c.pinned = true;
        c.starred = true;
        let actions = possible_actions(&c);
        assert!(actions.contains(&Action::Unpin) && !actions.contains(&Action::Pin));
        assert!(actions.contains(&Action::Unstar) && !actions.contains(&Action::Star));
        let off = ServerSettings::from_list(&[json!({"_id": "Message_AllowStarring", "value": false})]);
        let actions = possible_actions(&ctx(&off, &none, "bob", 1));
        assert!(!actions.contains(&Action::Star) && !actions.contains(&Action::Unstar));
    }

    #[test]
    fn permissions_follow_roles() {
        let response = json!({"update": [
            {"_id": "pin-message", "roles": ["owner", "moderator", "admin"]},
            {"_id": "edit-message", "roles": ["admin"]},
            {"_id": "view-logs", "roles": ["user"]},
        ]});
        let known = permission_roles(&response);
        assert_eq!(known.len(), 3);
        assert_eq!(granted(&known, &["user".into(), "owner".into()]), ["pin-message", "view-logs"]);
        assert!(granted(&known, &["guest".into()]).is_empty());
        let s = settings();
        let none: Vec<String> = vec![];
        assert!(!possible_actions(&ctx(&s, &none, "me", 1)).contains(&Action::Pin));
    }

    #[test]
    fn unknown_permissions_leave_it_to_the_server() {
        let s = settings();
        let none: Vec<String> = vec![];
        let mut c = ctx(&s, &none, "me", 1);
        c.permissions = None;
        let actions = possible_actions(&c);
        assert!(actions.contains(&Action::Edit) && actions.contains(&Action::Delete) && actions.contains(&Action::Pin));
        c.author_id = "bob";
        let theirs = possible_actions(&c);
        assert!(!theirs.contains(&Action::Edit) && !theirs.contains(&Action::Delete));
        let within = vec!["edit-message".to_owned(), "delete-message".to_owned()];
        let moderated = possible_actions(&ctx(&s, &within, "bob", 1));
        assert!(moderated.contains(&Action::Edit) && moderated.contains(&Action::Delete));
        assert!(!possible_actions(&ctx(&s, &within, "bob", 999)).contains(&Action::Edit));
    }
}
