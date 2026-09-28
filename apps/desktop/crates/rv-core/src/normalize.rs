//! Rocket.Chat documents to local rows. Port of the Android app's
//! `lib/normaliser.ts`: every server quirk about document shapes lives here.

use chrono::DateTime;
use serde_json::Value;

pub const ENCRYPTED_TYPE: &str = "e2e";

/// Rocket.Chat sends dates either as EJSON `{"$date": epochMs}` or as ISO strings.
pub fn to_epoch(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => n.as_f64().map(|f| f as i64),
        Value::String(s) => parse_iso(s),
        Value::Object(o) => match o.get("$date")? {
            Value::Number(n) => n.as_f64().map(|f| f as i64),
            Value::String(s) => parse_iso(s),
            _ => None,
        },
        _ => None,
    }
}

fn parse_iso(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

fn string(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn integer(v: Option<&Value>) -> i64 {
    v.and_then(Value::as_i64).unwrap_or(0)
}

fn boolean(v: Option<&Value>) -> bool {
    v.and_then(Value::as_bool).unwrap_or(false)
}

fn json_or_none(v: Option<&Value>) -> Option<String> {
    match v {
        Some(v @ (Value::Object(_) | Value::Array(_))) => Some(v.to_string()),
        _ => None,
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Message {
    pub id: String,
    pub rid: String,
    pub text: Option<String>,
    pub ts: i64,
    pub author_id: String,
    pub author_name: Option<String>,
    pub system_type: Option<String>,
    pub thread_id: Option<String>,
    pub thread_count: i64,
    pub thread_last: Option<i64>,
    pub thread_shown: bool,
    pub edited_at: Option<i64>,
    pub attachments: Option<String>,
    pub reactions: Option<String>,
    pub encrypted_raw: Option<String>,
    pub updated_at: i64,
    /// The server's pre-parsed markdown tree (message-parser), serialized.
    pub md: Option<String>,
    /// Link metadata the server fetched (`urls`), serialized.
    pub urls: Option<String>,
    /// A call message's `callId`, from its `video_conf` block (not its `_id`).
    pub call_id: Option<String>,
    pub pinned: bool,
    /// The users who starred it, by id, comma-separated.
    pub starred: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Room {
    pub rid: String,
    pub kind: String,
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub encrypted: bool,
    pub read_only: bool,
    pub dm_other_uid: Option<String>,
    pub last_message: Option<String>,
    pub last_message_type: Option<String>,
    pub last_message_author: Option<String>,
    /// An encrypted room's last message `content`, for a preview once unlocked.
    pub last_encrypted: Option<String>,
    pub last_message_ts: Option<i64>,
    pub avatar_etag: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Subscription {
    pub rid: String,
    pub sub_id: Option<String>,
    pub unread: i64,
    pub mentions: i64,
    pub group_mentions: i64,
    pub alert: bool,
    pub open: bool,
    pub favorite: bool,
    pub last_seen: Option<i64>,
    pub updated_at: i64,
    /// The room's AES key wrapped for me (`E2EKey`), in an encrypted room.
    pub e2e_key: Option<String>,
}

pub fn to_message(raw: &Value) -> Option<Message> {
    let author = raw.get("u");
    let id = string(raw.get("_id"))?;
    let rid = string(raw.get("rid"))?;
    let author_id = string(author.and_then(|a| a.get("_id")))?;
    let ts = to_epoch(raw.get("ts")?)?;
    let system_type = string(raw.get("t"));
    // The `msg` of an encrypted message is opaque base64: never stored, so it
    // can never be shown by accident.
    let encrypted = system_type.as_deref() == Some(ENCRYPTED_TYPE);

    Some(Message {
        id,
        rid,
        text: if encrypted { None } else { string(raw.get("msg")) },
        ts,
        author_id,
        author_name: string(author.and_then(|a| a.get("username"))),
        thread_id: string(raw.get("tmid")),
        thread_count: integer(raw.get("tcount")),
        thread_last: raw.get("tlm").and_then(to_epoch),
        thread_shown: boolean(raw.get("tshow")),
        edited_at: raw.get("editedAt").and_then(to_epoch),
        attachments: if encrypted { None } else { json_or_none(raw.get("attachments")) },
        reactions: json_or_none(raw.get("reactions")),
        encrypted_raw: if encrypted { json_or_none(raw.get("content")) } else { None },
        md: if encrypted { None } else { json_or_none(raw.get("md")) },
        urls: if encrypted { None } else { json_or_none(raw.get("urls")) },
        call_id: raw
            .get("blocks")
            .and_then(Value::as_array)
            .and_then(|blocks| blocks.iter().find(|b| b.get("type").and_then(Value::as_str) == Some("video_conf")))
            .and_then(|b| string(b.get("callId"))),
        pinned: boolean(raw.get("pinned")),
        starred: raw
            .get("starred")
            .and_then(Value::as_array)
            .map(|users| users.iter().filter_map(|u| string(u.get("_id"))).collect::<Vec<_>>().join(","))
            .filter(|ids| !ids.is_empty()),
        updated_at: raw.get("_updatedAt").and_then(to_epoch).unwrap_or(ts),
        system_type,
    })
}

/// A message that is only an attachment has `msg: ''`: fall back on the
/// file's caption, then its title, or the list keeps the previous preview.
fn preview_of(last: Option<&Value>) -> Option<String> {
    let last = last?;
    if let Some(text) = string(last.get("msg")) {
        return Some(text);
    }
    last.get("attachments")?
        .as_array()?
        .iter()
        .find_map(|a| string(a.get("description")).or_else(|| string(a.get("title"))))
}

pub fn to_room(raw: &Value, me: &str, me_uid: &str) -> Option<Room> {
    let rid = string(raw.get("_id"))?;
    let kind = string(raw.get("t"))?;
    let encrypted = boolean(raw.get("encrypted"));
    let is_dm = kind == "d";

    let dm_names: Vec<String> = raw
        .get("usernames")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|u| string(Some(u))).collect())
        .unwrap_or_default();
    // `me` is frozen at login: after a rename it may no longer be in
    // `usernames`. Only exclude ourselves when we are provably there.
    let me_inside = !me.is_empty() && dm_names.iter().any(|n| n == me);

    let name = string(raw.get("name"));
    let mut display_name = string(raw.get("fname")).or_else(|| name.clone());
    if display_name.is_none() && is_dm && raw.get("usernames").is_some_and(Value::is_array) {
        let others: Vec<&str> = dm_names.iter().map(String::as_str).filter(|n| !me_inside || *n != me).collect();
        display_name =
            if others.is_empty() { (!me.is_empty()).then(|| me.to_owned()) } else { Some(others.join(", ")) };
    }

    // `uids` and `usernames` are NOT aligned (checked on 8.5): only filter by uid.
    let mut dm_other_uid = None;
    if is_dm
        && !me_uid.is_empty()
        && let Some(uids) = raw.get("uids").and_then(Value::as_array)
    {
        let uids: Vec<String> = uids.iter().filter_map(|u| string(Some(u))).collect();
        if uids.len() <= 2 && uids.iter().any(|u| u == me_uid) {
            dm_other_uid = Some(uids.iter().find(|u| *u != me_uid).cloned().unwrap_or_else(|| me_uid.to_owned()));
        }
    }

    let last = raw.get("lastMessage");
    Some(Room {
        rid,
        kind,
        name,
        display_name,
        encrypted,
        read_only: boolean(raw.get("ro")),
        dm_other_uid,
        // An encrypted room's preview is ciphertext. Elsewhere a missing
        // `lastMessage` means the last message was deleted: None clears it.
        last_message: if encrypted { None } else { preview_of(last) },
        last_message_type: if encrypted { None } else { string(last.and_then(|l| l.get("t"))) },
        last_message_author: string(last.and_then(|l| l.pointer("/u/username"))),
        last_encrypted: if encrypted { json_or_none(last.and_then(|l| l.get("content"))) } else { None },
        last_message_ts: last.and_then(|l| l.get("ts")).and_then(to_epoch).or_else(|| raw.get("lm").and_then(to_epoch)),
        avatar_etag: string(raw.get("avatarETag")),
        updated_at: raw.get("_updatedAt").and_then(to_epoch).unwrap_or(0),
    })
}

pub fn to_subscription(raw: &Value) -> Option<Subscription> {
    Some(Subscription {
        rid: string(raw.get("rid"))?,
        sub_id: string(raw.get("_id")),
        unread: integer(raw.get("unread")),
        mentions: integer(raw.get("userMentions")),
        group_mentions: integer(raw.get("groupMentions")),
        alert: boolean(raw.get("alert")),
        open: boolean(raw.get("open")),
        favorite: boolean(raw.get("f")),
        last_seen: raw.get("ls").and_then(to_epoch),
        updated_at: raw.get("_updatedAt").and_then(to_epoch).unwrap_or(0),
        e2e_key: string(raw.get("E2EKey")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn epoch_formats() {
        assert_eq!(to_epoch(&json!(1700000000123_i64)), Some(1700000000123));
        assert_eq!(to_epoch(&json!("2023-11-14T22:13:20.123Z")), Some(1700000000123));
        assert_eq!(to_epoch(&json!({"$date": 1700000000123_i64})), Some(1700000000123));
        assert_eq!(to_epoch(&json!({"$date": "2023-11-14T22:13:20.123Z"})), Some(1700000000123));
        assert_eq!(to_epoch(&json!("not a date")), None);
        assert_eq!(to_epoch(&Value::Null), None);
    }

    #[test]
    fn message_requires_identity() {
        assert!(to_message(&json!({"rid":"r","ts":1,"u":{"_id":"u"}})).is_none());
        assert!(to_message(&json!({"_id":"m","ts":1,"u":{"_id":"u"}})).is_none());
        assert!(to_message(&json!({"_id":"m","rid":"r","u":{"_id":"u"}})).is_none());
        assert!(to_message(&json!({"_id":"m","rid":"r","ts":1})).is_none());
        assert!(to_message(&json!({"_id":"m","rid":"r","ts":1,"u":{"_id":"u"}})).is_some());
    }

    #[test]
    fn message_fields() {
        let m = to_message(&json!({"_id":"m","rid":"r","msg":"hi","ts":{"$date":10},"_updatedAt":{"$date":20},
            "u":{"_id":"u","username":"alice"},"tmid":"t","tshow":true,"tcount":3,"editedAt":{"$date":15},
            "attachments":[{"title":"a.png"}]}))
        .unwrap();
        assert_eq!(m.text.as_deref(), Some("hi"));
        assert_eq!((m.ts, m.updated_at), (10, 20));
        assert_eq!(m.author_name.as_deref(), Some("alice"));
        assert_eq!(m.thread_id.as_deref(), Some("t"));
        assert!(m.thread_shown);
        assert_eq!(m.thread_count, 3);
        assert_eq!(m.edited_at, Some(15));
        assert_eq!(m.attachments.as_deref(), Some(r#"[{"title":"a.png"}]"#));
    }

    #[test]
    fn pin_and_stars_are_kept() {
        let raw = json!({"_id": "m", "rid": "r", "ts": {"$date": 1}, "u": {"_id": "u"}, "pinned": true,
            "starred": [{"_id": "a"}, {"_id": "b"}]});
        let m = to_message(&raw).unwrap();
        assert!(m.pinned);
        assert_eq!(m.starred.as_deref(), Some("a,b"));
        let bare =
            to_message(&json!({"_id": "m", "rid": "r", "ts": {"$date": 1}, "u": {"_id": "u"}, "starred": []})).unwrap();
        assert!(!bare.pinned && bare.starred.is_none());
    }
    #[test]
    fn call_id_comes_from_the_block() {
        let m = to_message(&json!({"_id":"m","rid":"r","ts":1,"u":{"_id":"u"},"t":"videoconf",
            "blocks":[{"type":"section"},{"type":"video_conf","callId":"call-1","appId":"videoconf-core"}],
            "urls":[{"url":"https://example.com"}]}))
        .unwrap();
        assert_eq!(m.call_id.as_deref(), Some("call-1"));
        assert_eq!(m.urls.as_deref(), Some(r#"[{"url":"https://example.com"}]"#));
    }

    #[test]
    fn updated_at_falls_back_on_ts() {
        let m = to_message(&json!({"_id":"m","rid":"r","ts":10,"u":{"_id":"u"}})).unwrap();
        assert_eq!(m.updated_at, 10);
    }

    #[test]
    fn encrypted_message_never_stores_ciphertext() {
        let m = to_message(&json!({"_id":"m","rid":"r","t":"e2e","msg":"b64opaque","ts":1,"u":{"_id":"u"},
            "content":{"algorithm":"rc.v2.aes-sha2","ciphertext":"xyz"},"attachments":[{"title":"x"}]}))
        .unwrap();
        assert!(m.text.is_none());
        assert!(m.attachments.is_none());
        assert!(m.encrypted_raw.unwrap().contains("ciphertext"));
    }

    #[test]
    fn empty_msg_is_none() {
        let m = to_message(&json!({"_id":"m","rid":"r","msg":"","ts":1,"u":{"_id":"u"}})).unwrap();
        assert!(m.text.is_none());
    }

    #[test]
    fn direct_message_excludes_me() {
        let r = to_room(&json!({"_id":"d1","t":"d","usernames":["me","bob"],"uids":["U2","U1"]}), "me", "U1").unwrap();
        assert_eq!(r.display_name.as_deref(), Some("bob"));
        assert_eq!(r.dm_other_uid.as_deref(), Some("U2"));
    }

    #[test]
    fn direct_message_with_renamed_me_keeps_everyone() {
        let r = to_room(&json!({"_id":"d1","t":"d","usernames":["newme","bob"]}), "oldme", "").unwrap();
        assert_eq!(r.display_name.as_deref(), Some("newme, bob"));
    }

    #[test]
    fn direct_message_with_myself_is_me() {
        let r = to_room(&json!({"_id":"d1","t":"d","usernames":["me"],"uids":["U1"]}), "me", "U1").unwrap();
        assert_eq!(r.display_name.as_deref(), Some("me"));
        assert_eq!(r.dm_other_uid.as_deref(), Some("U1"));
    }

    #[test]
    fn fname_wins_over_name() {
        let r = to_room(&json!({"_id":"c1","t":"c","name":"general","fname":"General"}), "", "").unwrap();
        assert_eq!(r.display_name.as_deref(), Some("General"));
        assert_eq!(r.name.as_deref(), Some("general"));
    }

    #[test]
    fn attachment_only_last_message_uses_caption() {
        let r = to_room(
            &json!({"_id":"c1","t":"c","lastMessage":{"msg":"","ts":{"$date":5},
                "attachments":[{"title":"cat.png","description":"my cat"}]}}),
            "",
            "",
        )
        .unwrap();
        assert_eq!(r.last_message.as_deref(), Some("my cat"));
        assert_eq!(r.last_message_ts, Some(5));
    }

    #[test]
    fn system_last_message_keeps_type_and_author() {
        let r = to_room(
            &json!({"_id":"c1","t":"c","lastMessage":{"msg":"bob","t":"uj","u":{"username":"bob"},"ts":{"$date":5}}}),
            "",
            "",
        )
        .unwrap();
        assert_eq!(r.last_message_type.as_deref(), Some("uj"));
        assert_eq!(r.last_message_author.as_deref(), Some("bob"));
    }

    #[test]
    fn missing_last_message_clears_preview() {
        let r = to_room(&json!({"_id":"c1","t":"c","lm":{"$date":7}}), "", "").unwrap();
        assert!(r.last_message.is_none());
        assert_eq!(r.last_message_ts, Some(7));
    }

    #[test]
    fn encrypted_room_hides_preview() {
        let r = to_room(&json!({"_id":"p1","t":"p","encrypted":true,"lastMessage":{"msg":"cipher"}}), "", "").unwrap();
        assert!(r.encrypted);
        assert!(r.last_message.is_none());
    }

    #[test]
    fn subscription_fields() {
        let s = to_subscription(&json!({"_id":"s1","rid":"r","unread":4,"userMentions":1,"groupMentions":2,
            "alert":true,"open":true,"f":true,"ls":{"$date":9},"_updatedAt":{"$date":11}}))
        .unwrap();
        assert_eq!(s.sub_id.as_deref(), Some("s1"));
        assert_eq!((s.unread, s.mentions, s.group_mentions), (4, 1, 2));
        assert!(s.alert && s.open && s.favorite);
        assert_eq!((s.last_seen, s.updated_at), (Some(9), 11));
        assert!(to_subscription(&json!({"_id":"s1"})).is_none());
    }
}
