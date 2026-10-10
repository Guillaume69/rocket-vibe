//! Rocket.Chat's REST calls behind `Session`'s actions, the counterpart of
//! `mattermost::actions`: each answers in the core's own types, so a
//! `Session` method is one match on its `Backend` plus what both share
//! (store writes, events). The message actions shared with the display
//! rules (react, edit, pin...) stay in `crate::actions`.

use serde_json::{Value, json};

use crate::account::Me;
use crate::info::{self, Profile, RoomInfo};
use crate::live::{self, Presence};
use crate::normalize::Message;
use crate::rest::{CallOptions, RestClient, RestError, TwoFactorCode};
use crate::rooms::Found;

/// Everyone's presence at once (`users.presence`).
pub async fn presence(rest: &RestClient) -> Result<Vec<(String, Presence)>, RestError> {
    Ok(live::presence_list(&rest.get("users.presence", CallOptions::default()).await?))
}

/// Answers when the server has a video-conference provider.
pub async fn video_conference(rest: &RestClient) -> Result<(), RestError> {
    rest.get("video-conference.capabilities", CallOptions::default()).await.map(|_| ())
}

pub async fn room_info(rest: &RestClient, rid: &str) -> Result<RoomInfo, RestError> {
    room(rest.get("rooms.info", CallOptions::params([("roomId", rid)])).await?)
}

pub async fn room_by_name(rest: &RestClient, name: &str) -> Result<RoomInfo, RestError> {
    room(rest.get("rooms.info", CallOptions::params([("roomName", name)])).await?)
}

fn room(response: Value) -> Result<RoomInfo, RestError> {
    response.get("room").and_then(info::room_info).ok_or_else(|| RestError::incomplete("rooms.info: no room"))
}

/// By username, or by id when `by_id`.
pub async fn profile(rest: &RestClient, key: &str, by_id: bool) -> Result<Profile, RestError> {
    let param = if by_id { "userId" } else { "username" };
    let response = rest.get("users.info", CallOptions::params([(param, key)])).await?;
    response.get("user").and_then(info::profile).ok_or_else(|| RestError::incomplete("users.info: no user"))
}

pub async fn search(rest: &RestClient, rid: &str, text: &str) -> Result<Vec<Message>, RestError> {
    let options = CallOptions::params([("roomId", rid), ("searchText", text), ("count", "50")]);
    Ok(info::search_results(&rest.get("chat.search", options).await?))
}

pub async fn me(rest: &RestClient) -> Result<Me, RestError> {
    Ok(crate::account::me(&rest.get("me", CallOptions::default()).await?))
}

/// Both at once: `users.setStatus` clears whichever one is left out.
pub async fn set_status(rest: &RestClient, status: &str, message: &str) -> Result<(), RestError> {
    let body = json!({"status": status, "message": message});
    rest.post("users.setStatus", CallOptions::body(body)).await.map(|_| ())
}

/// `current_password` is already hashed (`two_factor_code("password", ..)`).
pub async fn update_basic_info(
    rest: &RestClient,
    mut data: serde_json::Map<String, Value>,
    current_password: Option<String>,
    two_factor: Option<TwoFactorCode>,
) -> Result<(), RestError> {
    if let Some(password) = current_password {
        data.insert("currentPassword".into(), json!(password));
    }
    let options = CallOptions { body: Some(json!({"data": data})), two_factor, ..Default::default() };
    rest.post("users.updateOwnBasicInfo", options).await.map(|_| ())
}

pub async fn reset_avatar(rest: &RestClient) -> Result<(), RestError> {
    rest.post("users.resetAvatar", CallOptions::body(json!({}))).await.map(|_| ())
}

pub async fn set_preference(rest: &RestClient, key: &str, value: &Value) -> Result<(), RestError> {
    rest.post("users.setPreferences", CallOptions::body(json!({"data": {key: value}}))).await.map(|_| ())
}

pub async fn spotlight(rest: &RestClient, query: &str) -> Result<Vec<Found>, RestError> {
    Ok(crate::rooms::spotlight_results(&rest.get("spotlight", CallOptions::params([("query", query)])).await?))
}

/// The DM with this user, created if needed: its rid.
pub async fn open_dm(rest: &RestClient, username: &str) -> Result<String, RestError> {
    let response = rest.post("im.create", CallOptions::body(json!({"username": username}))).await?;
    response
        .pointer("/room/_id")
        .or_else(|| response.pointer("/room/rid"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| RestError::incomplete("im.create: no room"))
}

pub async fn join(rest: &RestClient, rid: &str) -> Result<(), RestError> {
    rest.post("channels.join", CallOptions::body(json!({"roomId": rid}))).await.map(|_| ())
}

pub async fn mark_read(rest: &RestClient, rid: &str) -> Result<(), RestError> {
    rest.post("subscriptions.read", CallOptions::body(json!({"rid": rid}))).await.map(|_| ())
}

/// The room's invite (`findOrCreateInvite`, 7 days, any number of uses):
/// the same user, room and settings get the same one back. Its id.
pub async fn find_or_create_invite(rest: &RestClient, rid: &str) -> Result<String, RestError> {
    let body = json!({"rid": rid, "days": crate::actions::INVITE_DAYS, "maxUses": 0});
    let invite = rest.post("findOrCreateInvite", CallOptions::body(body)).await?;
    invite
        .get("_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| RestError::incomplete("findOrCreateInvite: no invite id"))
}

/// Creates a discussion of the room `prid` (`rooms.createDiscussion`), from
/// one of its messages (`pmid`, left unchanged), with a first message
/// (`reply`). The server takes an empty name: the caller refuses one. The
/// new room's document.
pub async fn create_discussion(
    rest: &RestClient,
    prid: &str,
    name: &str,
    pmid: Option<&str>,
    reply: Option<&str>,
) -> Result<Value, RestError> {
    let mut body = json!({"prid": prid, "t_name": name});
    if let Some(pmid) = pmid {
        body["pmid"] = json!(pmid);
    }
    if let Some(reply) = reply.map(str::trim).filter(|r| !r.is_empty()) {
        body["reply"] = json!(reply);
    }
    let response = rest.post("rooms.createDiscussion", CallOptions::body(body)).await?;
    response
        .get("discussion")
        .filter(|d| d.get("_id").and_then(Value::as_str).is_some())
        .cloned()
        .ok_or_else(|| RestError::incomplete("rooms.createDiscussion: no discussion"))
}
