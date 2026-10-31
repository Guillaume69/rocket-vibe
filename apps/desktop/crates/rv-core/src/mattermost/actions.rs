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

fn emoji_name(shortcode: &str) -> String {
    super::translate::reaction_name(shortcode)
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

/// Renames a channel: its display name only, the address (`name`) stays.
pub async fn rename(rest: &RestClient, channel: &str, display_name: &str) -> Result<Value, RestError> {
    rest.put(&format!("channels/{channel}/patch"), CallOptions::body(json!({"display_name": display_name}))).await
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

/// The conversation list settings kChat's web app shows, kept as the
/// account's preferences: `display_settings/name_format` (unless the server's
/// `LockTeammateNameDisplay`) and `sidebar_settings/limit_visible_dms_gms`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SidebarSettings {
    pub name_format: super::directory::NameFormat,
    /// The server imposes its format: shown, not offered.
    pub name_locked: bool,
    pub dm_limit: usize,
}

pub async fn sidebar_settings(rest: &RestClient) -> Result<SidebarSettings, RestError> {
    use super::directory::NameFormat;
    let (prefs, config) = tokio::join!(
        rest.get("users/me/preferences", CallOptions::default()),
        rest.get("config/client", CallOptions::params([("format", "old")])),
    );
    let (prefs, config) = (prefs?, config.unwrap_or(Value::Null));
    let value = |category: &str, name: &str| {
        prefs.as_array().into_iter().flatten().find_map(|p| {
            (text(p, "category").as_deref() == Some(category) && text(p, "name").as_deref() == Some(name))
                .then(|| text(p, "value"))
                .flatten()
        })
    };
    let locked = text(&config, "LockTeammateNameDisplay").as_deref() == Some("true");
    let server = NameFormat::parse(text(&config, "TeammateNameDisplay").as_deref()).unwrap_or_default();
    let mine = NameFormat::parse(value("display_settings", "name_format").as_deref());
    let limit =
        value("sidebar_settings", "limit_visible_dms_gms").and_then(|v| v.parse::<usize>().ok()).filter(|l| *l > 0);
    Ok(SidebarSettings {
        name_format: if locked { server } else { mine.unwrap_or(server) },
        name_locked: locked,
        dm_limit: limit.unwrap_or(super::categories::DEFAULT_DM_LIMIT),
    })
}

pub async fn set_sidebar_settings(
    rest: &RestClient,
    me: &str,
    name_format: Option<super::directory::NameFormat>,
    dm_limit: Option<usize>,
) -> Result<(), RestError> {
    let mut body = Vec::new();
    if let Some(format) = name_format {
        body.push(
            json!({"user_id": me, "category": "display_settings", "name": "name_format", "value": format.as_str()}),
        );
    }
    if let Some(limit) = dm_limit {
        body.push(json!({"user_id": me, "category": "sidebar_settings", "name": "limit_visible_dms_gms", "value": limit.to_string()}));
    }
    if body.is_empty() {
        return Ok(());
    }
    rest.put("users/me/preferences", CallOptions::body(Value::Array(body))).await.map(|_| ())
}

/// kChat's calls: kMeet meetings its server opens, as Infomaniak's own app
/// does. `POST /conferences {channel_id}` starts one in a room (and posts its
/// `custom_call`), `POST /conferences/<id>/answer` joins one; both answer the
/// meeting's `url` and a `jwt` for it.
pub async fn start_conference(rest: &RestClient, rid: &str) -> Result<String, RestError> {
    meeting(&rest.post("conferences", CallOptions::body(json!({"channel_id": rid}))).await?)
}

pub async fn answer_conference(rest: &RestClient, id: &str) -> Result<String, RestError> {
    meeting(&rest.post(&format!("conferences/{id}/answer"), CallOptions::default()).await?)
}

pub async fn decline_conference(rest: &RestClient, id: &str) -> Result<(), RestError> {
    rest.post(&format!("conferences/{id}/decline"), CallOptions::default()).await.map(|_| ())
}

/// The call view opens `url?jwt=`, on kMeet's origin only.
fn meeting(conference: &Value) -> Result<String, RestError> {
    let url = text(conference, "url").filter(|u| super::translate::is_kmeet(u));
    let url = url.ok_or_else(|| RestError::incomplete("conference: not a kMeet meeting"))?;
    Ok(match text(conference, "jwt") {
        Some(jwt) => format!("{url}?jwt={}", url::form_urlencoded::byte_serialize(jwt.as_bytes()).collect::<String>()),
        None => url,
    })
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
    let shown = json!([{"user_id": me, "category": "direct_channel_show", "name": other.id, "value": "true"}]);
    let _ = rest.put("users/me/preferences", CallOptions::body(shown)).await;
    text(&channel, "id").ok_or_else(|| RestError::incomplete("channels/direct: no channel"))
}

/// The group channel with these people and me, created if needed: the same
/// set gives the same channel back. 3 to 8 members, me included.
pub async fn open_group_dm(
    rest: &RestClient,
    mm: &MmSync,
    me: &str,
    usernames: &[String],
) -> Result<String, RestError> {
    let mut ids = vec![me.to_owned()];
    for username in usernames {
        let user = mm.directory.by_name(rest, username).await.ok_or_else(|| RestError::incomplete("no such user"))?;
        ids.push(user.id);
    }
    let channel = rest.post("channels/group", CallOptions::body(json!(ids))).await?;
    let rid = text(&channel, "id").ok_or_else(|| RestError::incomplete("channels/group: no channel"))?;
    let shown = json!([{"user_id": me, "category": "group_channel_show", "name": rid, "value": "true"}]);
    let _ = rest.put("users/me/preferences", CallOptions::body(shown)).await;
    Ok(rid)
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

/// A card menu's people (label the username, value the id) or channels of the
/// room's team (label the display name, value the id) matching `term`.
pub async fn menu_options(
    rest: &RestClient,
    rid: &str,
    source: &crate::content::MenuSource,
    term: &str,
) -> Result<Vec<(String, String)>, RestError> {
    use crate::content::MenuSource;
    let term = term.trim().trim_start_matches(['@', '~']);
    let found = match source {
        MenuSource::Options => return Ok(Vec::new()),
        MenuSource::Users => rest.post("users/search", CallOptions::body(json!({"term": term, "limit": 20}))).await?,
        MenuSource::Channels => {
            let room = rest.get(&format!("channels/{rid}"), CallOptions::default()).await.ok();
            let team = match room.as_ref().and_then(|room| text(room, "team_id")) {
                Some(team) => team,
                None => first_team(rest).await?,
            };
            rest.post(&format!("teams/{team}/channels/search"), CallOptions::body(json!({"term": term}))).await?
        }
    };
    let (label, fallback) = match source {
        MenuSource::Channels => ("display_name", "name"),
        _ => ("username", "username"),
    };
    Ok(found
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| Some((text(v, label).or_else(|| text(v, fallback))?, text(v, "id")?)))
        .take(20)
        .collect())
}

/// Matches in the room, newest first.
pub async fn search(rest: &RestClient, mm: &MmSync, rid: &str, terms: &str) -> Result<Vec<Message>, RestError> {
    let (team, scope) = search_target(rest, mm, rid).await?;
    let terms = format!("{terms} in:{scope}");
    let body = json!({"terms": terms, "is_or_search": false, "page": 0, "per_page": 60});
    let found = rest.post(&format!("teams/{team}/posts/search"), CallOptions::body(body)).await?;
    let posts: Vec<Value> =
        ordered(&found).into_iter().filter(|p| p.get("channel_id").and_then(Value::as_str) == Some(rid)).collect();
    mm.ensure_authors(&posts).await;
    Ok(posts.iter().filter_map(|p| mm.translate(p)).collect())
}

fn safe_search_scope(value: Option<String>) -> Result<String, RestError> {
    value
        .filter(|value| !value.is_empty() && !value.chars().any(|c| c.is_whitespace() || ",:@\"\\".contains(c)))
        .ok_or_else(|| RestError::incomplete("search: room identity unavailable"))
}

async fn search_target(rest: &RestClient, mm: &MmSync, rid: &str) -> Result<(String, String), RestError> {
    let room = rest.get(&format!("channels/{rid}"), CallOptions::default()).await?;
    let scope = match room.get("type").and_then(Value::as_str) {
        Some("O" | "P") => safe_search_scope(text(&room, "name"))?,
        Some(kind @ ("D" | "G")) => {
            let members = super::pages(rest, &format!("channels/{rid}/members")).await?;
            let mut ids: Vec<String> = members.iter().filter_map(|member| text(member, "user_id")).collect();
            ids.sort();
            ids.dedup();
            if !ids.iter().any(|id| id == mm.my_id()) {
                return Err(RestError::incomplete("search: room membership unavailable"));
            }
            if kind == "D" {
                ids.retain(|id| id != mm.my_id());
                if ids.is_empty() {
                    ids.push(mm.my_id().to_owned());
                }
                if ids.len() != 1 {
                    return Err(RestError::incomplete("search: DM identity unavailable"));
                }
            }
            mm.directory.ensure(rest, ids.clone()).await;
            let mut names =
                ids.iter().map(|id| safe_search_scope(mm.directory.username(id))).collect::<Result<Vec<_>, _>>()?;
            names.sort();
            format!("@{}", names.join(","))
        }
        _ => return Err(RestError::incomplete("search: room type unavailable")),
    };
    let team = match text(&room, "team_id") {
        Some(team) => team,
        None => first_team(rest).await?,
    };
    Ok((team, scope))
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

pub async fn set_activity(rest: &RestClient, me: &str, status: Presence) -> Result<Presence, RestError> {
    let wire = if status == Presence::Busy { "dnd" } else { status.as_str() };
    let result = rest.put("users/me/status", CallOptions::body(json!({"user_id": me, "status": wire}))).await?;
    if result.get("user_id").and_then(Value::as_str) != Some(me) {
        return Err(RestError::incomplete("Unexpected activity response."));
    }
    result
        .get("status")
        .and_then(Value::as_str)
        .and_then(presence)
        .ok_or_else(|| RestError::incomplete("Unexpected activity response."))
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
