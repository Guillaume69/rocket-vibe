//! kChat real time: Infomaniak replaced Mattermost's WebSocket with the Pusher
//! protocol (read in `Infomaniak/mobile-kchat` and `webapp-kChat`, no public
//! spec). The socket is `wss://<WebsocketURL>/app/kchat-key`; each channel is
//! authorized by the team server (`POST /broadcasting/auth`, form
//! `channel_name` + `socket_id`, bearer) before `pusher:subscribe`.
//!
//! Event names are Mattermost's; the Pusher `data` is the Mattermost event's
//! `data`, without the `broadcast` envelope, nested documents as objects.

use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Value, json};

use super::socket::{LiveEvent, Sink, Stream, next_json, send};
use crate::rest::{CallOptions, RestClient};

const DEFAULT_HOST: &str = "websocket.kchat.infomaniak.com";
const APP_KEY: &str = "kchat-key";
const HANDSHAKE: Duration = Duration::from_secs(15);

/// `data` is a JSON string on the wire; an object is accepted too.
fn decode(raw: Option<&Value>) -> Value {
    match raw {
        Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::Null),
        Some(v) => v.clone(),
        None => Value::Null,
    }
}

fn host_of(url: &str) -> Option<String> {
    let host = url.trim_start_matches("wss://").trim_start_matches("ws://");
    let host = host.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/');
    (!host.is_empty()).then(|| host.to_owned())
}

/// The channels an account listens on: its team, and itself twice (the
/// numeric Infomaniak id, the Mattermost id).
pub fn channels(me: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(team) = me.get("team_id").and_then(Value::as_str) {
        out.push(format!("private-team.{team}"));
    }
    match me.get("user_id") {
        Some(Value::Number(n)) => out.push(format!("presence-user.{n}")),
        Some(Value::String(s)) if !s.is_empty() => out.push(format!("presence-user.{s}")),
        _ => {}
    }
    if let Some(id) = me.get("id").and_then(Value::as_str) {
        out.push(format!("presence-teamUser.{id}"));
    }
    out
}

/// Waits for the named Pusher event, answering the server's pings meanwhile.
async fn wait_for(sink: &mut Sink, stream: &mut Stream, event: &str, channel: Option<&str>) -> Option<Value> {
    tokio::time::timeout(HANDSHAKE, async {
        while let Some(message) = next_json(stream).await {
            let name = message.get("event").and_then(Value::as_str).unwrap_or_default();
            if name == "pusher:ping" {
                let _ = send(sink, &json!({"event": "pusher:pong", "data": {}})).await;
                continue;
            }
            if name == "pusher:error" {
                return None;
            }
            if name == event && channel.is_none_or(|c| message.get("channel").and_then(Value::as_str) == Some(c)) {
                return Some(decode(message.get("data")));
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

async fn authorize(rest: &RestClient, token: &str, channel: &str, socket_id: &str) -> Option<Value> {
    let url = format!("{}/broadcasting/auth", rest.base().as_str().trim_end_matches('/'));
    let form = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([("channel_name", channel), ("socket_id", socket_id)])
        .finish();
    let response = reqwest::Client::builder()
        .timeout(HANDSHAKE)
        .build()
        .ok()?
        .post(url)
        .bearer_auth(token)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    serde_json::from_str(&response.text().await.ok()?).ok()
}

pub(crate) async fn connect(rest: &RestClient, token: &str) -> Option<(Sink, Stream)> {
    let config = CallOptions::params([("format", "old")]);
    let (config, me) = tokio::join!(rest.get("config/client", config), rest.get("users/me", CallOptions::default()));
    let me = me.ok()?;
    let host = config
        .ok()
        .and_then(|c| c.get("WebsocketURL").and_then(Value::as_str).and_then(host_of))
        .unwrap_or_else(|| DEFAULT_HOST.to_owned());
    let url = format!("wss://{host}/app/{APP_KEY}?protocol=7&client=js&version=8.3.0&flash=false");
    let (socket, _) = tokio::time::timeout(HANDSHAKE, tokio_tungstenite::connect_async(url)).await.ok()?.ok()?;
    let (mut sink, mut stream) = socket.split();
    let established = wait_for(&mut sink, &mut stream, "pusher:connection_established", None).await?;
    let socket_id = established.get("socket_id").and_then(Value::as_str)?.to_owned();
    for channel in channels(&me) {
        let auth = authorize(rest, token, &channel, &socket_id).await?;
        let data = json!({"channel": channel, "auth": auth.get("auth"), "channel_data": auth.get("channel_data")});
        if !send(&mut sink, &json!({"event": "pusher:subscribe", "data": data})).await {
            return None;
        }
        wait_for(&mut sink, &mut stream, "pusher_internal:subscription_succeeded", Some(&channel)).await?;
    }
    Some((sink, stream))
}

/// One frame once connected: a Mattermost event goes to `emit`; a server
/// ping returns the pong to send.
pub(crate) fn frame(message: &Value, emit: impl FnOnce(LiveEvent)) -> Option<Value> {
    let name = message.get("event").and_then(Value::as_str)?;
    if name == "pusher:ping" {
        return Some(json!({"event": "pusher:pong", "data": {}}));
    }
    if name.starts_with("pusher") || name.starts_with("client-") {
        return None;
    }
    emit(LiveEvent::Event { name: name.to_owned(), data: decode(message.get("data")), broadcast: Value::Null });
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_account_listens_on_its_team_and_itself() {
        let me = json!({"id": "mm1", "user_id": 42, "team_id": "t1"});
        assert_eq!(channels(&me), ["private-team.t1", "presence-user.42", "presence-teamUser.mm1"]);
    }

    #[test]
    fn frames_decode_their_data_and_answer_pings() {
        let mut got = None;
        let raw = json!({"event": "posted", "channel": "private-team.t1", "data": "{\"post\":{\"id\":\"p1\"}}"});
        assert!(frame(&raw, |e| got = Some(e)).is_none());
        assert_eq!(
            got,
            Some(LiveEvent::Event {
                name: "posted".into(),
                data: json!({"post": {"id": "p1"}}),
                broadcast: Value::Null
            })
        );
        assert!(frame(&json!({"event": "pusher:ping", "data": "{}"}), |_| panic!()).is_some());
        assert!(frame(&json!({"event": "pusher_internal:member_added"}), |_| panic!()).is_none());
    }

    #[test]
    fn the_socket_host_drops_its_scheme() {
        assert_eq!(host_of("wss://websocket.kchat.infomaniak.com/").as_deref(), Some("websocket.kchat.infomaniak.com"));
        assert_eq!(host_of(""), None);
    }
}
