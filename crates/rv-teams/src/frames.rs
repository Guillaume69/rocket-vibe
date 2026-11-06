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

/// The socket's activity, as Teams' web app reports it (`state` "active" or
/// "inactive"): Unified Presence counts an endpoint reporting through its
/// transport as present only while it says so.
pub fn user_activity(active: bool, cv: &str) -> String {
    let state = if active { "active" } else { "inactive" };
    let event = json!({"name": "user.activity", "args": [{"state": state, "cv": cv}]});
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

/// The presence changes Unified Presence pushes to the chat registration's
/// `unifiedPresenceService` path, for the people it was asked to watch:
/// `{presence: [{mri, presence: {availability, activity, ...}}]}`.
pub fn presence_push(envelope: &Value) -> Option<Value> {
    let url = envelope.get("url").and_then(Value::as_str)?;
    if !url.trim_end_matches('/').ends_with("/unifiedPresenceService") {
        return None;
    }
    let body: Value = match envelope.get("body")? {
        Value::String(raw) => serde_json::from_str(raw).ok()?,
        other => other.clone(),
    };
    body.get("presence").is_some_and(Value::is_array).then_some(body)
}

/// A call pushed to the calling registration (`SkypeSpacesWeb`): `evt` 107
/// rings, the conversation events after it (115 joined elsewhere, 116 over)
/// end the ring of the same call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallPush {
    Ring(Ring),
    Moved { call_id: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ring {
    pub call_id: String,
    pub caller_mri: String,
    pub caller_name: Option<String>,
    /// Declines it: a `DELETE` with a `callEnd`.
    pub reject: Option<String>,
    pub multi_party: bool,
    /// A group call's conversation, when the push names one.
    pub thread: Option<String>,
}

const RING: i64 = 107;
const JOINED_ELSEWHERE: i64 = 115;
const CONVERSATION_OVER: i64 = 116;

pub fn call_push(envelope: &Value) -> Option<CallPush> {
    let body: Value = match envelope.get("body")? {
        Value::String(raw) => serde_json::from_str(raw).ok()?,
        other => other.clone(),
    };
    let evt = body.get("evt").and_then(Value::as_i64)?;
    let text =
        |v: &Value, path: &str| v.pointer(path).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    match evt {
        RING => {
            let gp: Value = serde_json::from_slice(&unbase64(body.get("gp")?.as_str()?)?).ok()?;
            let call = gp.get("callNotification")?;
            Some(CallPush::Ring(Ring {
                call_id: text(&gp, "/debugContent/callId")?,
                caller_mri: text(call, "/from/id")?,
                caller_name: text(call, "/from/displayName"),
                reject: text(call, "/links/reject").filter(|u| u.starts_with("https://")),
                multi_party: gp
                    .pointer("/conversationInvitation/isMultiParty")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                thread: gp.get("groupContext").and_then(thread_in),
            }))
        }
        JOINED_ELSEWHERE | CONVERSATION_OVER => {
            let call_id = body
                .get("cp")
                .and_then(Value::as_str)
                .and_then(unbase64)
                .and_then(|zipped| gunzip(&zipped))
                .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
                .and_then(|cp| text(&cp, "/correlationId"));
            Some(CallPush::Moved { call_id })
        }
        _ => None,
    }
}

/// The `callEnd` a decline sends to the ring's `reject` link (Teams' web
/// client: `CALL_END_CODE.REJECT`, `LOCAL_USER_INITIATED`).
pub fn decline_body() -> Value {
    json!({"callEnd": {"code": 603, "subCode": 0, "phrase": "CallEndReasonLocalUserInitiated", "resultCategories": ["Success"]}})
}

fn unbase64(raw: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig, general_purpose};
    let lenient = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    lenient.decode(raw.trim()).ok().or_else(|| general_purpose::URL_SAFE_NO_PAD.decode(raw.trim()).ok())
}

fn gunzip(bytes: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes).take(1 << 20).read_to_end(&mut out).ok()?;
    Some(out)
}

/// The first `19:…@thread…` conversation id anywhere in a value.
fn thread_in(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if s.starts_with("19:") && s.contains("@thread") => Some(s.clone()),
        Value::Array(items) => items.iter().find_map(thread_in),
        Value::Object(map) => map.values().find_map(thread_in),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_presence_push_is_read_from_its_path_only() {
        let body = r#"{"presence":[{"mri":"8:orgid:a","etag":"A1","presence":{"availability":"Available","activity":"Available"}}]}"#;
        let push = json!({"id": 1, "method": "POST", "url": "/v4/f/abc/unifiedPresenceService", "body": body});
        let read = presence_push(&push).unwrap();
        assert_eq!(read["presence"][0]["presence"]["availability"], "Available");
        assert!(presence_push(&json!({"id": 1, "url": "/v4/f/abc/messaging", "body": body})).is_none());
        assert!(presence_push(&json!({"id": 1, "url": "/v4/f/abc/unifiedPresenceService", "body": "{}"})).is_none());
    }

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
    fn activity_is_reported_as_the_web_app_does() {
        assert_eq!(
            user_activity(true, "cv1"),
            r#"5:::{"args":[{"cv":"cv1","state":"active"}],"name":"user.activity"}"#
        );
        assert!(user_activity(false, "cv1").contains(r#""state":"inactive""#));
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

    fn push(body: Value) -> Value {
        json!({"id": 1, "method": "POST", "url": "/v4/f/abc/", "body": body.to_string()})
    }

    #[test]
    fn a_ring_names_its_caller_and_decline_link() {
        use base64::Engine;
        let gp = json!({
            "callNotification": {
                "from": {"id": "8:orgid:caller", "displayName": "Ada Lovelace"},
                "to": {"id": "8:orgid:me"},
                "links": {"reject": "https://api.flightproxy.teams.microsoft.com/api/v2/ep/cc/forked/x/reject?i=1", "attach": "https://x/attach"},
            },
            "conversationInvitation": {"conversationController": "https://x/conv/1", "isMultiParty": false, "isBroadcast": false},
            "debugContent": {"callId": "589ac9cc-0000-4000-8000-000000000000"},
            "groupContext": null,
        });
        let encoded = base64::engine::general_purpose::STANDARD_NO_PAD.encode(gp.to_string());
        let Some(CallPush::Ring(ring)) = call_push(&push(json!({"evt": 107, "gp": encoded}))) else { panic!("a ring") };
        assert_eq!(ring.call_id, "589ac9cc-0000-4000-8000-000000000000");
        assert_eq!((ring.caller_mri.as_str(), ring.caller_name.as_deref()), ("8:orgid:caller", Some("Ada Lovelace")));
        assert!(ring.reject.unwrap().ends_with("/reject?i=1"));
        assert!(!ring.multi_party);
        assert_eq!(ring.thread, None);
    }

    #[test]
    fn a_group_ring_keeps_its_conversation() {
        use base64::Engine;
        let gp = json!({
            "callNotification": {"from": {"id": "8:orgid:caller"}, "links": {}},
            "conversationInvitation": {"isMultiParty": true},
            "debugContent": {"callId": "c"},
            "groupContext": {"threadId": "19:abc@thread.v2", "messageId": "0"},
        });
        let encoded = base64::engine::general_purpose::STANDARD.encode(gp.to_string());
        let Some(CallPush::Ring(ring)) = call_push(&push(json!({"evt": 107, "gp": encoded}))) else { panic!("a ring") };
        assert!(ring.multi_party);
        assert_eq!(ring.thread.as_deref(), Some("19:abc@thread.v2"));
        assert_eq!(ring.reject, None);
    }

    #[test]
    fn the_call_answered_elsewhere_or_over_ends_its_ring() {
        use base64::Engine;
        use std::io::Write;
        let cp = json!({"correlationId": "589ac9cc", "conversationController": "https://x/conv/1", "participants": ["8:orgid:a", "8:orgid:b"]});
        let mut zip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        zip.write_all(cp.to_string().as_bytes()).unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode(zip.finish().unwrap());
        for evt in [115, 116] {
            assert_eq!(
                call_push(&push(json!({"evt": evt, "cp": encoded}))),
                Some(CallPush::Moved { call_id: Some("589ac9cc".into()) })
            );
        }
        assert_eq!(call_push(&push(json!({"evt": 116, "cp": "not gzip"}))), Some(CallPush::Moved { call_id: None }));
        assert_eq!(call_push(&push(json!({"evt": 1}))), None);
        assert_eq!(call_push(&push(json!({"resourceType": "NewMessage"}))), None);
        assert_eq!(decline_body()["callEnd"]["code"], 603);
    }
}
