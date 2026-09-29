//! The system's own notifications and app badge on Windows (WinRT toasts,
//! taskbar badge) and macOS (UNUserNotificationCenter, dock badge), where
//! GLib's backends fall short: a tray balloon without clicks on Windows, the
//! deprecated NSUserNotification on macOS. No GTK here: events come back on
//! whatever thread the system uses, and the caller hops to its own.
//!
//! On other systems every call is a no-op and `available` is false.

/// What the user did with a notification: opened it, or answered from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Open { room: String, message: String },
    Reply { room: String, message: String, text: String },
}

pub type Handler = Box<dyn Fn(Event) + Send + Sync>;

/// One notification per room: a newer one replaces it.
pub struct Toast<'a> {
    pub room: &'a str,
    pub message: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    /// Offer an inline reply field.
    pub reply: Option<ReplyLabels<'a>>,
}

pub struct ReplyLabels<'a> {
    pub placeholder: &'a str,
    pub send: &'a str,
}

#[cfg(windows)]
mod windows_impl;
#[cfg(windows)]
pub use windows_impl::{available, badge, init, show, withdraw};

#[cfg(target_os = "macos")]
mod macos_impl;
#[cfg(target_os = "macos")]
pub use macos_impl::{available, badge, init, show, withdraw};

#[cfg(not(any(windows, target_os = "macos")))]
mod other {
    use super::{Handler, Toast};

    pub fn init(_app_id: &str, _display_name: &str, _handler: Handler) {}
    pub fn available() -> bool {
        false
    }
    pub fn show(_toast: &Toast) {}
    pub fn withdraw(_room: &str) {}
    pub fn badge(_count: i64) {}
}
#[cfg(not(any(windows, target_os = "macos")))]
pub use other::{available, badge, init, show, withdraw};

/// Toast arguments carry the room and the message, `|`-separated; ids never hold one.
pub fn encode(room: &str, message: &str) -> String {
    format!("{room}|{message}")
}

pub fn decode(arguments: &str) -> Option<(String, String)> {
    let (room, message) = arguments.split_once('|')?;
    (!room.is_empty()).then(|| (room.to_owned(), message.to_owned()))
}

/// XML text, escaped.
pub fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// A Windows toast: title, body, and when asked a reply box and its button.
pub fn toast_xml(toast: &Toast) -> String {
    let launch = xml_escape(&encode(toast.room, toast.message));
    let actions = toast.reply.as_ref().map_or_else(String::new, |labels| {
        format!(
            "<actions><input id=\"reply\" type=\"text\" placeHolderContent=\"{}\"/>\
             <action content=\"{}\" arguments=\"{launch}\" hint-inputId=\"reply\"/></actions>",
            xml_escape(labels.placeholder),
            xml_escape(labels.send),
        )
    });
    format!(
        "<toast launch=\"{launch}\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text>\
         </binding></visual>{actions}</toast>",
        xml_escape(toast.title),
        xml_escape(toast.body),
    )
}

/// A toast tag names the room: at most 64 chars, so a long id is hashed.
pub fn tag(room: &str) -> String {
    if room.len() <= 64 {
        return room.to_owned();
    }
    let hash = room.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_round_trip() {
        assert_eq!(decode(&encode("r1", "m1")), Some(("r1".into(), "m1".into())));
        assert_eq!(decode("nothing"), None);
        assert_eq!(decode("|m"), None);
    }

    #[test]
    fn toast_xml_escapes_and_offers_a_reply() {
        let toast = Toast {
            room: "r",
            message: "m",
            title: "bob <3",
            body: "a & b",
            reply: Some(ReplyLabels { placeholder: "Reply", send: "Send" }),
        };
        let xml = toast_xml(&toast);
        assert!(xml.contains("<text>bob &lt;3</text><text>a &amp; b</text>"));
        assert!(xml.contains("launch=\"r|m\""));
        assert!(xml.contains("hint-inputId=\"reply\""));
        let plain = toast_xml(&Toast { reply: None, ..toast });
        assert!(!plain.contains("<actions>"));
    }

    #[test]
    fn tags_stay_short() {
        assert_eq!(tag("GENERAL"), "GENERAL");
        assert_eq!(tag(&"x".repeat(80)).len(), 16);
    }
}
