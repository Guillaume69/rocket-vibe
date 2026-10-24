//! The protocol rv-core speaks with the engine: commands in, frames out, one
//! JSON object each. The same objects the Go helper used, field for field.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

fn is_false(b: &bool) -> bool {
    !*b
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

pub(crate) mod base64_bytes {
    use base64::Engine as _;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD
            .decode(text)
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct Command {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub chat: String,
    #[serde(default)]
    pub text: String,
    /// For a send: the id of the message it answers.
    #[serde(default)]
    pub reply: String,
    /// For an upload: the local file, its type and name, and whether the app
    /// recorded it as a voice note.
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub mime: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub voice: bool,
}

/// A message as the client projects it. Ids are `<chat>:<WhatsApp id>`, the
/// chat in its canonical form (the phone number once WhatsApp mapped the LID).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub chat: String,
    pub name: String,
    pub sender: String,
    pub author: String,
    pub text: String,
    pub ts: i64,
    pub mine: bool,
    /// `sending` until the network answered, `uncertain` when it never did.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub status: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub edited: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
    /// How far my message went: delivered, read or played.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub receipt: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reply_to: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub quote_sender: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub quote_text: String,
    /// image, gif, video, audio, voice, document or sticker; the text is then its caption.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub mime: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub file_name: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub size: i64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub width: i64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub height: i64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub seconds: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty", with = "base64_bytes")]
    pub thumb: Vec<u8>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub link_url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub link_title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub link_description: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub link_image: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Reaction {
    pub message: String,
    pub sender: String,
    /// Empty once the reaction was taken back.
    pub emoji: String,
    pub ts: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Person {
    pub jid: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Typing {
    pub chat: String,
    pub sender: String,
    /// composing, recording or paused.
    pub state: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Call {
    pub id: String,
    pub from: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub group: String,
    #[serde(skip_serializing_if = "is_false")]
    pub video: bool,
    /// ringing or ended.
    pub state: String,
}

/// A frame to the client.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Frame {
    Qr {
        code: String,
        expires_ms: i64,
    },
    Status {
        state: String,
    },
    Message {
        message: Box<Message>,
    },
    /// With an id, the error refuses one send, which never left the computer.
    Error {
        code: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    Sent {
        id: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        state: String,
    },
    Names {
        names: BTreeMap<String, String>,
    },
    /// A photo in base64, empty when the person has none.
    Avatar {
        jid: String,
        data: String,
    },
    Reaction {
        reaction: Reaction,
    },
    /// The client drops its projection and takes the whole cache again.
    Reload,
    /// The end of a replay.
    Replayed,
    Chat {
        jid: String,
        unread: i64,
    },
    Account {
        jid: String,
        name: String,
    },
    Typing {
        typing: Typing,
    },
    Call {
        call: Call,
    },
    PairingCode {
        code: String,
    },
    /// Where a downloaded attachment is; empty on failure.
    File {
        id: String,
        path: String,
    },
    Found {
        id: String,
        people: Vec<Person>,
    },
}

impl Frame {
    pub fn status(state: &str) -> Self {
        Frame::Status {
            state: state.to_owned(),
        }
    }

    pub fn error(code: &str) -> Self {
        Frame::Error {
            code: code.to_owned(),
            id: None,
        }
    }

    pub fn refusal(id: &str, code: &str) -> Self {
        Frame::Error {
            code: code.to_owned(),
            id: Some(id.to_owned()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_read_as_the_go_helper_wrote_them() {
        let m = Message {
            id: "a@s.whatsapp.net:X".into(),
            text: "hi".into(),
            thumb: vec![1, 2],
            ..Message::default()
        };
        let json = serde_json::to_value(Frame::Message {
            message: Box::new(m),
        })
        .unwrap();
        assert_eq!(json["type"], "message");
        assert_eq!(json["message"]["thumb"], "AQI=");
        assert!(
            json["message"].get("status").is_none(),
            "empty fields are omitted"
        );
        assert_eq!(
            serde_json::to_value(Frame::Reload).unwrap(),
            serde_json::json!({"type": "reload"})
        );
        assert_eq!(
            serde_json::to_value(Frame::Chat {
                jid: "g@g.us".into(),
                unread: 0
            })
            .unwrap(),
            serde_json::json!({"type": "chat", "jid": "g@g.us", "unread": 0})
        );
        assert_eq!(
            serde_json::to_value(Frame::Found {
                id: "s".into(),
                people: vec![]
            })
            .unwrap(),
            serde_json::json!({"type": "found", "id": "s", "people": []}),
            "an empty answer still lists its people"
        );
    }

    #[test]
    fn commands_read_with_their_defaults() {
        let cmd: Command = serde_json::from_str(
            r#"{"type":"send","id":"ABCDEF0123","chat":"a@s.whatsapp.net","text":"hi"}"#,
        )
        .unwrap();
        assert_eq!(
            (cmd.kind.as_str(), cmd.reply.as_str(), cmd.voice),
            ("send", "", false)
        );
    }
}
