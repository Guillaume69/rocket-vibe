//! What the screens do to a Mattermost or kChat server, in the shapes the
//! Rocket.Chat calls return so `Session` hands the same types back.

use serde_json::{Value, json};

use super::directory::User;
use super::sync::{MmSync, ordered};
use crate::account::Me;
use crate::info::{Profile, RoomInfo};
use crate::live::Presence;
use crate::normalize::Message;
use crate::rest::{CallOptions, RestClient, RestError};
use crate::rooms::Found;

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn emoji_name(shortcode: &str) -> &str {
    shortcode.trim_matches(':')
}

/// Mattermost says `dnd` where Rocket.Chat says `busy`.
pub fn presence(status: &str) -> Option<Presence> {
    Presence::parse(if status == "dnd" { "busy" } else { status })
}

pub async fn react(rest: &RestClient, me: &str, post_id: &str, shortcode: &str, add: bool) -> Result<(), RestError> {
    let name = emoji_name(shortcode);
    if add {
        let body = json!({"user_id": me, "post_id": post_id, "emoji_name": name});
        rest.post("reactions", CallOptions::body(body)).await.map(|_| ())
    } else {
        rest.delete(&format!("users/{me}/posts/{post_id}/reactions/{name}"), CallOptions::default()).await.map(|_| ())
    }
}

/// The edited post.
pub async fn edit(rest: &RestClient, post_id: &str, text: &str) -> Result<Value, RestError> {
    rest.put(&format!("posts/{post_id}/patch"), CallOptions::body(json!({"message": text}))).await
}

pub async fn delete(rest: &RestClient, post_id: &str) -> Result<(), RestError> {
    rest.delete(&format!("posts/{post_id}"), CallOptions::default()).await.map(|_| ())
}

/// Pins or unpins, then the post as the server now has it.
pub async fn pin(rest: &RestClient, post_id: &str, on: bool) -> Result<Value, RestError> {
    let verb = if on { "pin" } else { "unpin" };
    rest.post(&format!("posts/{post_id}/{verb}"), CallOptions::default()).await?;
    rest.get(&format!("posts/{post_id}"), CallOptions::default()).await
}

/// Stars a post (Mattermost's flagged post), or takes the star away.
pub async fn flag(rest: &RestClient, me: &str, post_id: &str, on: bool) -> Result<(), RestError> {
    let preference = json!([{"user_id": me, "category": "flagged_post", "name": post_id, "value": "true"}]);
    if on {
        rest.put("users/me/preferences", CallOptions::body(preference)).await.map(|_| ())
    } else {
        rest.post("users/me/preferences/delete", CallOptions::body(preference)).await.map(|_| ())
    }
}

/// The server moves the room in or out of my Favorites category, and says so with `sidebar_category_updated`.
pub async fn favorite(rest: &RestClient, me: &str, rid: &str, on: bool) -> Result<(), RestError> {
    let preference = json!([{"user_id": me, "category": "favorite_channel", "name": rid, "value": on.to_string()}]);
    rest.put("users/me/preferences", CallOptions::body(preference)).await.map(|_| ())
}

/// The server's custom emoji: each name → its image, which Mattermost serves by id only.
pub async fn custom_emojis(rest: &RestClient) -> Result<Vec<(String, String)>, RestError> {
    let list = super::pages(rest, "emoji").await?;
    Ok(list
        .iter()
        .filter_map(|e| {
            let (id, name) = (e.get("id")?.as_str()?, e.get("name")?.as_str()?);
            Some((name.to_owned(), format!("/api/v4/emoji/{id}/image")))
        })
        .collect())
}

pub async fn flagged(rest: &RestClient, rid: &str) -> Result<Vec<Value>, RestError> {
    let options = CallOptions::params([("channel_id", rid), ("per_page", "100")]);
    Ok(ordered(&rest.get("users/me/posts/flagged", options).await?))
}

pub async fn pinned(rest: &RestClient, rid: &str) -> Result<Vec<Value>, RestError> {
    Ok(ordered(&rest.get(&format!("channels/{rid}/pinned"), CallOptions::default()).await?))
}

pub async fn mark_read(rest: &RestClient, rid: &str) -> Result<(), RestError> {
    rest.post("channels/members/me/view", CallOptions::body(json!({"channel_id": rid}))).await.map(|_| ())
}

/// The DM channel with this user, created if needed.
pub async fn open_dm(rest: &RestClient, mm: &MmSync, me: &str, username: &str) -> Result<String, RestError> {
    let other = mm.directory.by_name(rest, username).await.ok_or_else(|| RestError::incomplete("no such user"))?;
    let channel = rest.post("channels/direct", CallOptions::body(json!([me, other.id]))).await?;
    text(&channel, "id").ok_or_else(|| RestError::incomplete("channels/direct: no channel"))
}

pub async fn join(rest: &RestClient, me: &str, rid: &str) -> Result<(), RestError> {
    rest.post(&format!("channels/{rid}/members"), CallOptions::body(json!({"user_id": me}))).await.map(|_| ())
}

async fn first_team(rest: &RestClient) -> Result<String, RestError> {
    let teams = rest.get("users/me/teams", CallOptions::default()).await?;
    teams
        .as_array()
        .and_then(|t| t.first())
        .and_then(|t| text(t, "id"))
        .ok_or_else(|| RestError::incomplete("users/me/teams: no team"))
}

/// The room's team; a DM belongs to none, any team of mine searches it.
async fn team_of(rest: &RestClient, mm: &MmSync, rid: &str) -> Result<String, RestError> {
    match mm.team_of(rid) {
        Some(team) => Ok(team),
        None => first_team(rest).await,
    }
}

/// Matches in the room, newest first.
pub async fn search(rest: &RestClient, mm: &MmSync, rid: &str, terms: &str) -> Result<Vec<Message>, RestError> {
    let team = team_of(rest, mm, rid).await?;
    let body = json!({"terms": terms, "is_or_search": false, "page": 0, "per_page": 60});
    let found = rest.post(&format!("teams/{team}/posts/search"), CallOptions::body(body)).await?;
    let posts: Vec<Value> =
        ordered(&found).into_iter().filter(|p| p.get("channel_id").and_then(Value::as_str) == Some(rid)).collect();
    mm.ensure_authors(&posts).await;
    Ok(posts.iter().filter_map(|p| mm.translate(p)).collect())
}

pub async fn room_info(rest: &RestClient, rid: &str) -> Result<RoomInfo, RestError> {
    let (channel_path, stats_path) = (format!("channels/{rid}"), format!("channels/{rid}/stats"));
    let (channel, stats) =
        tokio::join!(rest.get(&channel_path, CallOptions::default()), rest.get(&stats_path, CallOptions::default()),);
    room_info_of(&channel?, stats.ok().as_ref())
}

pub fn room_info_of(channel: &Value, stats: Option<&Value>) -> Result<RoomInfo, RestError> {
    let id = text(channel, "id").ok_or_else(|| RestError::incomplete("channels: no channel"))?;
    let kind = match channel.get("type").and_then(Value::as_str) {
        Some("O") => "c",
        Some("P") => "p",
        _ => "d",
    };
    Ok(RoomInfo {
        id,
        name: text(channel, "display_name").or_else(|| text(channel, "name")).unwrap_or_default(),
        kind: kind.to_owned(),
        topic: text(channel, "header"),
        announcement: None,
        description: text(channel, "purpose"),
        members: stats.and_then(|s| s.get("member_count")).and_then(Value::as_i64),
        read_only: false,
        encrypted: false,
        archived: channel.get("delete_at").and_then(Value::as_i64).unwrap_or(0) > 0,
        default: text(channel, "name").as_deref() == Some("town-square"),
    })
}

/// A channel by its name (`~name`), in my first team.
pub async fn room_by_name(rest: &RestClient, name: &str) -> Result<RoomInfo, RestError> {
    let team = first_team(rest).await?;
    let channel = rest.get(&format!("teams/{team}/channels/name/{name}"), CallOptions::default()).await?;
    room_info_of(&channel, None)
}

pub async fn profile(rest: &RestClient, mm: &MmSync, key: &str, by_id: bool) -> Result<Profile, RestError> {
    let path = if by_id { format!("users/{key}") } else { format!("users/username/{key}") };
    let user = rest.get(&path, CallOptions::default()).await?;
    let id = text(&user, "id").ok_or_else(|| RestError::incomplete("users: no user"))?;
    if let Some(known) = User::from_json(&user) {
        mm.directory.remember(known);
    }
    let status = rest.get(&format!("users/{id}/status"), CallOptions::default()).await.ok();
    Ok(profile_of(&user, status.as_ref()))
}

pub fn profile_of(user: &Value, status: Option<&Value>) -> Profile {
    let name = User::from_json(user).and_then(|u| u.display);
    let custom = user
        .pointer("/props/customStatus")
        .and_then(Value::as_str)
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok().and_then(|c| text(&c, "text")));
    Profile {
        id: text(user, "id").unwrap_or_default(),
        username: text(user, "username").unwrap_or_default(),
        name,
        presence: status.and_then(|s| s.get("status")).and_then(Value::as_str).and_then(presence),
        status_text: custom,
        roles: text(user, "roles").map(|r| r.split_whitespace().map(str::to_owned).collect()).unwrap_or_default(),
        utc_offset: None,
        bio: text(user, "position"),
        avatar_etag: user.get("last_picture_update").and_then(Value::as_i64).map(|t| t.to_string()),
        bot: user.get("is_bot").and_then(Value::as_bool).unwrap_or(false),
        bot_owner: None,
    }
}

pub async fn me(rest: &RestClient) -> Result<Me, RestError> {
    let (user, status) =
        tokio::join!(rest.get("users/me", CallOptions::default()), rest.get("users/me/status", CallOptions::default()));
    Ok(me_of(&user?, status.ok().as_ref()))
}

pub fn me_of(user: &Value, status: Option<&Value>) -> Me {
    let profile = profile_of(user, status);
    let desktop = user.pointer("/notify_props/desktop").and_then(Value::as_str).unwrap_or("default");
    Me {
        username: profile.username,
        name: profile.name.unwrap_or_default(),
        email: text(user, "email").unwrap_or_default(),
        status: profile.presence.unwrap_or(Presence::Offline).as_str().to_owned(),
        status_text: profile.status_text.unwrap_or_default(),
        bio: profile.bio.unwrap_or_default(),
        avatar_etag: profile.avatar_etag,
        desktop_notifications: match desktop {
            "none" => "nothing".to_owned(),
            other => other.to_owned(),
        },
    }
}

/// Both at once, as on Rocket.Chat: the status, and the custom text (cleared when empty).
pub async fn set_status(rest: &RestClient, me: &str, status: &str, message: &str) -> Result<(), RestError> {
    let status = if status == "busy" { "dnd" } else { status };
    rest.put("users/me/status", CallOptions::body(json!({"user_id": me, "status": status}))).await?;
    if message.trim().is_empty() {
        rest.delete("users/me/status/custom", CallOptions::default()).await.map(|_| ())
    } else {
        rest.put("users/me/status/custom", CallOptions::body(json!({"text": message.trim()}))).await.map(|_| ())
    }
}

/// `desktopNotifications` onto `notify_props.desktop`: the whole map is sent
/// back, a patch replaces it.
pub async fn set_desktop_notifications(rest: &RestClient, value: &str) -> Result<(), RestError> {
    let user = rest.get("users/me", CallOptions::default()).await?;
    let mut props = user.get("notify_props").cloned().unwrap_or_else(|| json!({}));
    props["desktop"] = json!(if value == "nothing" { "none" } else { value });
    rest.put("users/me/patch", CallOptions::body(json!({"notify_props": props}))).await.map(|_| ())
}

/// `users.updateOwnBasicInfo`'s fields onto a user patch; username and email
/// need the current password there too.
pub async fn update_basic_info(
    rest: &RestClient,
    data: &serde_json::Map<String, Value>,
    password: Option<&str>,
) -> Result<(), RestError> {
    let mut patch = json!({});
    for (key, value) in data {
        let field = match key.as_str() {
            "name" => "nickname",
            "bio" => "position",
            other => other,
        };
        patch[field] = value.clone();
    }
    if let Some(password) = password {
        patch["password"] = json!(password);
    }
    rest.put("users/me/patch", CallOptions::body(patch)).await.map(|_| ())
}

/// People, then the public channels of my teams, matching the query.
pub async fn spotlight(rest: &RestClient, mm: &MmSync, query: &str) -> Result<Vec<Found>, RestError> {
    let q = query.trim().trim_start_matches(['@', '#', '~']);
    let users = rest.post("users/search", CallOptions::body(json!({"term": q, "limit": 20}))).await?;
    let mut found: Vec<Found> = users
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(User::from_json)
        .map(|u| {
            mm.directory.remember(u.clone());
            Found::User { id: u.id, username: u.username, name: u.display }
        })
        .collect();
    if let Ok(team) = first_team(rest).await {
        let body = json!({"term": q});
        if let Ok(channels) = rest.post(&format!("teams/{team}/channels/search"), CallOptions::body(body)).await {
            found.extend(channels.as_array().into_iter().flatten().filter_map(|c| {
                Some(Found::Room { id: text(c, "id")?, name: text(c, "name")?, kind: "c".to_owned() })
            }));
        }
    }
    Ok(found)
}

/// `<base>/_redirect/pl/<post>`: the server finds the team itself.
pub fn permalink(base: &str, post_id: &str) -> String {
    format!("{}/_redirect/pl/{post_id}", base.trim_end_matches('/'))
}

/// Statuses of these users, by id.
pub async fn statuses(rest: &RestClient, ids: &[String]) -> Result<Vec<(String, Presence)>, RestError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let list = rest.post("users/status/ids", CallOptions::body(json!(ids))).await?;
    Ok(list
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| Some((text(s, "user_id")?, presence(s.get("status")?.as_str()?)?)))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_reads_mattermost_fields() {
        let user = json!({"id": "u1", "username": "bob", "first_name": "Bob", "last_name": "B", "roles": "system_user",
            "position": "Ops", "last_picture_update": 17, "props": {"customStatus": "{\"text\":\"lunch\"}"}});
        let p = profile_of(&user, Some(&json!({"status": "dnd"})));
        assert_eq!(p.name.as_deref(), Some("Bob B"));
        assert_eq!(p.presence, Some(Presence::Busy));
        assert_eq!(
            (p.status_text.as_deref(), p.bio.as_deref(), p.avatar_etag.as_deref()),
            (Some("lunch"), Some("Ops"), Some("17"))
        );
        let me = me_of(&json!({"username": "bob", "notify_props": {"desktop": "none"}}), None);
        assert_eq!((me.status.as_str(), me.desktop_notifications.as_str()), ("offline", "nothing"));
    }

    #[test]
    fn room_info_maps_header_and_purpose() {
        let channel =
            json!({"id": "c1", "type": "P", "display_name": "Secret", "header": "h", "purpose": "p", "delete_at": 0});
        let info = room_info_of(&channel, Some(&json!({"member_count": 3}))).unwrap();
        assert_eq!((info.kind.as_str(), info.topic.as_deref(), info.members), ("p", Some("h"), Some(3)));
        assert_eq!(permalink("http://mm/", "p1"), "http://mm/_redirect/pl/p1");
    }
}
