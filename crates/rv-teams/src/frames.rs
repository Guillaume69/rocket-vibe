//! Trouter's socket.io 0.9 frames, `type:id:endpoint:data`, and the chat
//! events its pushed requests carry.

use serde_json::{Value, json};

#[derive(Debug, PartialEq)]
pub enum Frame {
    Connect,
    Heartbeat,
    /// A named event (`trouter.connected`, `trouter.message_loss`).
    Event(String),
    /// A pushed request; `ack` is the frame id to acknowledge, when it had one.
    Request {
        envelope: Value,
        ack: Option<String>,
    },
    Other,
}

pub fn parse(text: &str) -> Frame {
    let mut parts = text.splitn(4, ':');
    let kind = parts.next().unwrap_or_default();
    let id = parts.next().unwrap_or_default().trim_end_matches('+');
    let _endpoint = parts.next();
    let data = parts.next().unwrap_or_default();
    match kind {
        "1" => Frame::Connect,
        "2" => Frame::Heartbeat,
        "5" => serde_json::from_str::<Value>(data)
            .ok()
            .and_then(|v| v.get("name").and_then(Value::as_str).map(str::to_owned))
            .map_or(Frame::Other, Frame::Event),
        "3" => match serde_json::from_str::<Value>(data) {
            Ok(envelope) if envelope.is_object() => {
                Frame::Request { envelope, ack: (!id.is_empty()).then(|| id.to_owned()) }
            }
            _ => Frame::Other,
        },
        _ => Frame::Other,
    }
}

pub const HEARTBEAT: &str = "2::";

/// The event that proves the socket is mine.
pub fn authenticate(skype: &str, connect_params: &Value) -> String {
    let event = json!({"name": "user.authenticate", "args": [{"headers": {"X-Skypetoken": skype}, "connectparams": connect_params}]});
    format!("5:::{event}")
}

/// The answer a pushed request expects, or Trouter delivers it again.
pub fn reply(envelope: &Value) -> Option<String> {
    let id = envelope.get("id")?;
    let request = json!({"id": id, "src": "rv"}).to_string();
    let answer = json!({"id": id, "status": 200, "headers": {"trouter-request": request, "trouter-client": "{\"cd\":0}"}, "body": ""});
    Some(format!("3:::{answer}"))
}

pub fn ack(id: &str) -> String {
    format!("6:::{id}")
}

/// A pushed request's chat event: its resource type and resource, the
/// conversation link kept on it.
pub fn chat_event(envelope: &Value) -> Option<(String, Value)> {
    let body: Value = match envelope.get("body")? {
        Value::String(raw) => serde_json::from_str(raw).ok()?,
        other => other.clone(),
    };
    let kind = body.get("resourceType").and_then(Value::as_str)?.to_owned();
    let mut resource = body.get("resource").cloned().filter(Value::is_object)?;
    if resource.get("conversationLink").is_none()
        && let Some(link) = body.get("resourceLink").and_then(Value::as_str)
    {
        resource["conversationLink"] = json!(link.split("/messages/").next().unwrap_or(link));
    }
    Some((kind, resource))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_by_type() {
        assert_eq!(parse("1::"), Frame::Connect);
        assert_eq!(parse("2::"), Frame::Heartbeat);
        assert_eq!(parse(r#"5:::{"name":"trouter.connected","args":[{}]}"#), Frame::Event("trouter.connected".into()));
        assert_eq!(parse("8::"), Frame::Other);
        assert_eq!(parse("3:7+::not json"), Frame::Other);
        let Frame::Request { envelope, ack } = parse(r#"3:7+::{"id":42,"method":"POST","body":"{}"}"#) else {
            panic!("a request")
        };
        assert_eq!((envelope["id"].as_i64(), ack.as_deref()), (Some(42), Some("7")));
        assert!(reply(&envelope).unwrap().starts_with(r#"3:::{"#));
        assert!(reply(&envelope).unwrap().contains(r#""status":200"#));
    }

    #[test]
    fn a_push_names_its_resource_and_conversation() {
        let body = json!({
            "resourceType": "NewMessage",
            "resourceLink": "https://x/v1/users/ME/conversations/19:c@thread.v2/messages/5",
            "resource": {"id": "5", "content": "<p>hi</p>"},
        });
        let (kind, resource) = chat_event(&json!({"id": 1, "body": body.to_string()})).unwrap();
        assert_eq!(kind, "NewMessage");
        assert_eq!(resource["conversationLink"], "https://x/v1/users/ME/conversations/19:c@thread.v2");
        assert_eq!(super::super::translate::conversation_of(&resource).as_deref(), Some("19:c@thread.v2"));
        assert!(chat_event(&json!({"id": 1, "body": "{\"resourceType\":\"X\"}"})).is_none());
    }
}
