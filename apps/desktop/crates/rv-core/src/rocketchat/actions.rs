//! Rocket.Chat's REST calls behind `Session`'s actions, the counterpart of
//! `mattermost::actions`: each answers in the core's own types, so a
//! `Session` method is one match on its `Backend` plus what both share
//! (store writes, events). The message actions shared with the display
//! rules (react, edit, pin...) stay in `crate::actions`.

use serde_json::{Value, json};

use crate::account::Me;
use crate::info::{self, Profile, RoomInfo};
use crate::live::{self, Presence};
use crate::members;
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

/// Creates a channel, or a private group when `private`, owned by me and with
/// me as its only member (`channels.create` answers `{channel}`,
/// `groups.create` `{group}`). The name goes as given: the server owns its
/// rule. The new room's document.
pub async fn create_channel(rest: &RestClient, name: &str, private: bool) -> Result<Value, RestError> {
    let (route, key) = if private { ("groups.create", "group") } else { ("channels.create", "channel") };
    let response = rest.post(route, CallOptions::body(json!({"name": name}))).await?;
    response
        .get(key)
        .filter(|room| room.get("_id").and_then(Value::as_str).is_some())
        .cloned()
        .ok_or_else(|| RestError::incomplete(&format!("{route}: no room")))
}

/// The catalog key saying why a creation was refused. Without the right,
/// `channels.create` answers 403 and `groups.create` `error-not-allowed` (read
/// in the 8.5 bundle); a taken name is refused whatever the room's kind, a
/// malformed one by the server's `UTF8_Channel_Names_Validation` (probed on
/// 8.5.1).
pub fn creation_refusal(error: &RestError) -> &'static str {
    if error.status == 403 {
        return "new_channel.forbidden";
    }
    match error.error_type.as_deref() {
        Some("error-not-allowed") => "new_channel.forbidden",
        Some("error-duplicate-channel-name") => "new_channel.name_taken",
        Some("error-invalid-room-name") => "new_channel.name_invalid",
        _ => "new_channel.failed",
    }
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

/// A page of the room's members (`rooms.membersOrderedByRole`): owners,
/// then moderators, then the rest; `filter` is searched by the server. A DM
/// answers `error-room-type-not-supported`.
pub async fn members(
    rest: &RestClient,
    rid: &str,
    filter: &str,
    offset: u32,
) -> Result<members::MemberPage, RestError> {
    let (offset_text, count) = (offset.to_string(), members::PAGE.to_string());
    let mut params = vec![("roomId", rid), ("count", count.as_str()), ("offset", offset_text.as_str())];
    let filter = filter.trim();
    if !filter.is_empty() {
        params.push(("filter", filter));
    }
    let response = rest.get("rooms.membersOrderedByRole", CallOptions::params(params)).await?;
    Ok(members::member_page(&response, offset))
}

/// Gives or takes a room role, through `channels.*` or `groups.*` by the
/// room's `kind`. A refusal saying it is already so counts as done.
pub async fn set_member_role(
    rest: &RestClient,
    kind: &str,
    rid: &str,
    user_id: &str,
    role: members::Role,
    put: bool,
) -> Result<(), RestError> {
    let route = members::role_route(kind, role, put).ok_or_else(|| RestError::incomplete("roles: not in this room"))?;
    member_call(rest, &route, rid, user_id).await
}

/// Removes someone from the room (`channels.kick` / `groups.kick`).
pub async fn remove_member(rest: &RestClient, kind: &str, rid: &str, user_id: &str) -> Result<(), RestError> {
    let route = members::kick_route(kind).ok_or_else(|| RestError::incomplete("kick: not in this room"))?;
    member_call(rest, &route, rid, user_id).await
}

async fn member_call(rest: &RestClient, route: &str, rid: &str, user_id: &str) -> Result<(), RestError> {
    match rest.post(route, CallOptions::body(json!({"roomId": rid, "userId": user_id}))).await {
        Ok(_) => Ok(()),
        Err(e) if members::already_done(&e) => Ok(()),
        Err(e) => Err(e),
    }
}

/// `rooms.saveRoomSettings` with `fields` (`settings_changes`): it refuses
/// any unknown key, and checks `edit-room` itself.
pub async fn save_room_settings(
    rest: &RestClient,
    rid: &str,
    fields: serde_json::Map<String, Value>,
) -> Result<(), RestError> {
    let mut body = fields;
    body.insert("rid".into(), json!(rid));
    rest.post("rooms.saveRoomSettings", CallOptions::body(Value::Object(body))).await.map(|_| ())
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
