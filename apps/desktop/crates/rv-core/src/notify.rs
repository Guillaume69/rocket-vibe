//! Which live messages deserve a desktop notification, and what it says.

use serde_json::Value;

use crate::normalize::Message;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Incoming {
    pub rid: String,
    pub id: String,
    pub author: String,
    pub room_name: String,
    pub direct: bool,
    /// Without content for an encrypted message: the notification never shows ciphertext.
    pub body: Option<String>,
    pub mentions_me: bool,
}

fn mentions_in(node: &Value, names: &[&str]) -> bool {
    match node {
        Value::Array(items) => items.iter().any(|n| mentions_in(n, names)),
        Value::Object(map) => {
            let is_mention = map.get("type").and_then(Value::as_str) == Some("MENTION_USER");
            let target = map.get("value").and_then(|v| v.get("value")).and_then(Value::as_str);
            (is_mention && target.is_some_and(|t| names.contains(&t))) || map.values().any(|v| mentions_in(v, names))
        }
        _ => false,
    }
}

/// `@me`, `@all` or `@here`, from the parsed markdown, else from the text.
pub fn mentions_me(message: &Message, me: &str) -> bool {
    let names = [me, "all", "here"];
    if let Some(md) = message.md.as_deref().and_then(|m| serde_json::from_str::<Value>(m).ok()) {
        return mentions_in(&md, &names);
    }
    let text = message.text.as_deref().unwrap_or_default();
    names
        .iter()
        .any(|n| text.split(|c: char| c.is_whitespace() || ",;:!?".contains(c)).any(|w| w.strip_prefix('@') == Some(n)))
}

/// `all`, `nothing`, and otherwise (`mention`, `default`) DMs and mentions.
pub fn wanted(preference: &str, incoming: &Incoming) -> bool {
    match preference {
        "all" => true,
        "nothing" => false,
        _ => incoming.direct || incoming.mentions_me,
    }
}

/// The preference a room's messages follow: its own choice over the
/// account's, and nothing at all once another client silenced it
/// (`disableNotifications`).
pub fn room_preference<'a>(account: &'a str, own: Option<&'a str>, silenced: bool) -> &'a str {
    if silenced { "nothing" } else { own.unwrap_or(account) }
}

/// One line for the notification: the quote prefix and shortcodes resolved,
/// a file's name when there is no text.
pub fn body_of(message: &Message) -> String {
    let text = crate::actions::strip_quote_prefix(message.text.as_deref().unwrap_or_default()).trim().to_owned();
    if !text.is_empty() {
        return crate::emoji::replace_shortcodes(&text);
    }
    let files = crate::content::files(message.attachments.as_deref());
    let images = crate::media::image_attachments(message.attachments.as_deref());
    match (files.first(), images.first()) {
        (Some(f), _) => format!("📎 {}", f.title),
        (None, Some(i)) => format!("🖼️ {}", i.title.clone().unwrap_or_default()),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(text: &str, md: Option<Value>) -> Message {
        Message { text: Some(text.into()), md: md.map(|m| m.to_string()), ..Default::default() }
    }

    #[test]
    fn mentions() {
        let md = json!([{"type":"PARAGRAPH","value":[{"type":"MENTION_USER","value":{"type":"PLAIN_TEXT","value":"alice"}}]}]);
        assert!(mentions_me(&message("@alice hi", Some(md)), "alice"));
        assert!(mentions_me(&message("hey @here, look", None), "alice"));
        assert!(!mentions_me(&message("mail alice@x.org", None), "alice"));
        assert!(!mentions_me(&message("@alicette", None), "alice"));
    }

    #[test]
    fn preferences() {
        let base = Incoming {
            rid: "r".into(),
            id: "m".into(),
            author: "bob".into(),
            room_name: "general".into(),
            direct: false,
            body: None,
            mentions_me: false,
        };
        assert!(!wanted("default", &base));
        assert!(wanted("all", &base));
        assert!(wanted("mention", &Incoming { direct: true, ..base.clone() }));
        assert!(!wanted("nothing", &Incoming { mentions_me: true, ..base }));
    }

    #[test]
    fn a_rooms_own_choice_overrides_the_account() {
        let base = Incoming {
            rid: "r".into(),
            id: "m".into(),
            author: "bob".into(),
            room_name: "general".into(),
            direct: false,
            body: None,
            mentions_me: false,
        };
        assert!(wanted(room_preference("default", Some("all"), false), &base));
        assert!(!wanted(room_preference("all", Some("nothing"), false), &base));
        let mention = Incoming { mentions_me: true, ..base.clone() };
        assert!(!wanted(room_preference("all", Some("mentions"), false), &base));
        assert!(wanted(room_preference("nothing", Some("mentions"), false), &mention));
        assert!(wanted(room_preference("all", None, false), &base), "no choice of its own: the account's");
        assert!(!wanted(room_preference("all", Some("all"), true), &mention), "silenced by another client");
    }

    #[test]
    fn bodies() {
        assert_eq!(body_of(&message("[ ](http://x/c?msg=1) sure :smile:", None)), "sure 😄");
        let file = Message {
            attachments: Some(json!([{"title":"doc.pdf","title_link":"/f/doc.pdf"}]).to_string()),
            ..Default::default()
        };
        assert_eq!(body_of(&file), "📎 doc.pdf");
    }
}
