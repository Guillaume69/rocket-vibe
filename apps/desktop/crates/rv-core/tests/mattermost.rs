mod common;

use std::sync::Arc;

use common::{FakeHttp, respond};
use rv_core::mattermost::sync::MmSync;
use rv_core::mattermost::{self, actions, translate};
use rv_core::normalize::{Room, Subscription};
use rv_core::rest::{CallOptions, RestClient, is_token_rejected};
use rv_core::store::Store;
use serde_json::{Value, json};

fn page_of(target: &str) -> usize {
    target.split(['?', '&']).find_map(|p| p.strip_prefix("page=")).and_then(|n| n.parse().ok()).unwrap_or(0)
}

fn members(count: usize) -> Value {
    Value::Array((0..count).map(|i| json!({"channel_id": format!("c{i}")})).collect())
}

/// A server with one channel `ch1` that I read up to 6 roots of 8, and
/// whose counts the caller decides for `/users/me/channel_members`.
async fn bench(read_roots: i64, category: Option<&'static str>) -> FakeHttp {
    FakeHttp::start(move |r| match r.path() {
        "/api/v4/channels/ch1" => respond(
            200,
            &json!({"id": "ch1", "type": "O", "name": "dev", "display_name": "Dev", "total_msg_count": 10, "total_msg_count_root": 8, "update_at": 5})
                .to_string(),
        ),
        "/api/v4/channels/ch1/members/me" => respond(
            200,
            &json!({"channel_id": "ch1", "user_id": "u-me", "msg_count": 8, "msg_count_root": 6, "mention_count": 0, "last_update_at": 5})
                .to_string(),
        ),
        "/api/v4/users/me/channel_members" => respond(
            200,
            &json!([{"channel_id": "ch1", "user_id": "u-me", "msg_count": read_roots + 2, "msg_count_root": read_roots, "mention_count": 0, "last_update_at": 5}])
                .to_string(),
        ),
        "/api/v4/users/me/teams" => respond(200, r#"[{"id": "T"}]"#),
        "/api/v4/users/me/teams/T/channels/categories" => respond(
            200,
            &json!({"categories": [{"id": "g", "type": "custom", "display_name": category.unwrap_or(""), "channel_ids": if category.is_some() { vec!["ch1"] } else { vec![] }}], "order": ["g"]})
                .to_string(),
        ),
        _ => respond(404, r#"{"id": "api.context.404.app_error", "message": "Not found", "status_code": 404}"#),
    })
    .await
}

fn sync(server: &FakeHttp) -> (Arc<Store>, MmSync) {
    let store = Arc::new(Store::in_memory().unwrap());
    let sync = MmSync::new(store.clone(), RestClient::mattermost(server.url.clone()), "u-me", "me", false);
    (store, sync)
}

#[tokio::test]
async fn a_list_is_read_until_a_short_page() {
    let server =
        FakeHttp::start(|r| respond(200, &members(if page_of(&r.target) == 0 { 200 } else { 50 }).to_string())).await;
    let list =
        mattermost::pages(&RestClient::mattermost(server.url.clone()), "users/me/channel_members").await.unwrap();
    assert_eq!(list.len(), 250);
    assert_eq!(server.requests().len(), 2);
}

#[tokio::test]
async fn the_channel_list_is_read_once_whatever_its_size() {
    let full: Value = Value::Array((0..250).map(|i| json!({"id": format!("c{i}"), "delete_at": 0})).collect());
    let server = FakeHttp::start(move |_| respond(200, &full.to_string())).await;
    let (_, sync) = sync(&server);
    assert_eq!(sync.channels().await.unwrap().len(), 250);
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn badge_updated_clears_a_room_read_elsewhere() {
    let server = bench(8, None).await;
    let (store, sync) = sync(&server);
    sync.apply_event("channel_created", &json!({"channel": {"id": "ch1"}}), &json!({})).await;
    assert_eq!(store.rooms()[0].unread, 2);
    sync.apply_event("badge_updated", &json!({"badge": 0}), &json!({})).await;
    assert_eq!(store.rooms()[0].unread, 0);
}

#[tokio::test]
async fn badge_updated_leaves_rooms_whose_counts_did_not_move() {
    let server = bench(6, None).await;
    let (store, sync) = sync(&server);
    sync.apply_event("channel_created", &json!({"channel": {"id": "ch1"}}), &json!({})).await;
    let mut changes = store.changes();
    sync.apply_event("badge_updated", &json!({"badge": 2}), &json!({})).await;
    assert!(changes.try_recv().is_err(), "nothing moved, nothing written");
    assert_eq!(store.rooms()[0].unread, 2);
}

#[tokio::test]
async fn a_sidebar_category_event_regroups_the_rooms() {
    let server = bench(6, Some("TECH")).await;
    let (store, sync) = sync(&server);
    sync.apply_event("channel_created", &json!({"channel": {"id": "ch1"}}), &json!({})).await;
    assert_eq!(store.rooms()[0].group_name, None);
    sync.apply_event("sidebar_category_updated", &json!({}), &json!({"team_id": "T"})).await;
    let room = &store.rooms()[0];
    assert_eq!(
        (room.group_id.as_deref(), room.group_name.as_deref(), room.group_rank),
        (Some("g"), Some("TECH"), Some(0))
    );
}

#[tokio::test]
async fn custom_emoji_images_are_served_by_id() {
    let server = FakeHttp::start(|r| {
        let page = if page_of(&r.target) == 0 {
            json!([{"id": "e1", "name": "alb-youpi"}, {"name": "no-id"}])
        } else {
            json!([])
        };
        respond(200, &page.to_string())
    })
    .await;
    let list = actions::custom_emojis(&RestClient::mattermost(server.url.clone())).await.unwrap();
    assert_eq!(list, [("alb-youpi".to_owned(), "/api/v4/emoji/e1/image".to_owned())]);
}

#[tokio::test]
async fn a_mistyped_password_is_not_a_refused_token() {
    let password = r#"{"id": "api.user.check_user_password.invalid.app_error", "message": "Login failed because of invalid password.", "status_code": 401}"#;
    let expired = r#"{"id": "api.context.session_expired.app_error", "message": "Invalid or expired session", "status_code": 401}"#;
    let server = FakeHttp::queue(vec![respond(401, password), respond(401, expired)]).await;
    let rest = RestClient::mattermost(server.url.clone());
    let e =
        rest.put("users/me/patch", CallOptions::body(json!({"email": "x@y", "password": "nope"}))).await.unwrap_err();
    assert!(!is_token_rejected(&e));
    assert!(is_token_rejected(&rest.get("users/me", CallOptions::default()).await.unwrap_err()));
}

#[test]
fn only_a_kmeet_meeting_is_joined() {
    assert!(translate::is_kmeet("https://kmeet.infomaniak.com/r1"));
    for url in
        ["https://evil.example/r1", "https://kmeet.infomaniak.com@evil.example/", "http://kmeet.infomaniak.com/r1"]
    {
        assert!(!translate::is_kmeet(url), "{url}");
        assert_eq!(translate::kmeet_call(&json!({"url": url})).2, None, "{url}");
    }
}

#[test]
fn a_room_without_its_last_post_keeps_the_stored_preview() {
    let store = Store::in_memory().unwrap();
    let room = |preview: Option<&str>, keep: bool, at: i64| Room {
        rid: "r".into(),
        kind: "c".into(),
        name: Some("r".into()),
        last_message: preview.map(str::to_owned),
        last_message_ts: Some(at),
        updated_at: at,
        keep_preview: keep,
        ..Default::default()
    };
    store.write(|w| {
        w.upsert_room(&room(Some("hello"), false, 1));
        w.upsert_subscription(&Subscription { rid: "r".into(), open: true, updated_at: 1, ..Default::default() });
        w.upsert_room(&room(None, true, 2));
    });
    let row = &store.rooms()[0];
    assert_eq!((row.last_message.as_deref(), row.last_ts), (Some("hello"), 2));
    store.write(|w| w.upsert_room(&room(None, false, 3)));
    assert_eq!(store.rooms()[0].last_message, None);
}

#[test]
fn closed_and_old_conversations_leave_the_list() {
    use rv_core::mattermost::categories::Sidebar;
    let mut s = Sidebar::new("u-me");
    s.apply(
        &json!([{"category": "direct_channel_show", "name": "u-bob", "value": "false"},
                {"category": "sidebar_settings", "name": "limit_visible_dms_gms", "value": "1"}]),
        true,
    );
    let dm = |id: &str, other: &str, at: i64| json!({"id": id, "type": "D", "name": format!("u-me__{other}"), "last_post_at": at});
    let channels = [dm("fav", "u-a", 9), dm("bob", "u-bob", 8), dm("d1", "u-c", 7), dm("old", "u-d", 1)];
    s.rank(&channels, |rid| rid == "fav");
    let listed: Vec<bool> = channels.iter().map(|c| s.is_listed(c, 0, c["id"] == "fav")).collect();
    assert_eq!(listed, [true, false, true, false]);
    assert!(s.is_listed(&channels[1], 3, false), "something unread always shows");
    s.reveal("old");
    s.rank(&channels, |rid| rid == "fav");
    assert!(s.is_listed(&channels[3], 0, false), "opened in this session");
}

#[test]
fn names_follow_the_format_and_carry_the_status() {
    use rv_core::mattermost::directory::{Directory, NameFormat, User};
    let raw = json!({"id": "u-bob", "username": "bob", "first_name": "Bob", "last_name": "Builder", "nickname": "bob",
                     "props": {"customStatus": {"emoji": "palm_tree", "expires_at": "2999-01-01T00:00:00Z"}}});
    let d = Directory::default();
    d.remember(User::from_json(&raw).unwrap());
    assert_eq!(
        (d.display_name("u-bob").as_deref(), d.status_emoji("u-bob").as_deref()),
        (Some("Bob Builder"), Some("🌴"))
    );
    assert!(d.set_name_format(NameFormat::NicknameFullName));
    assert_eq!(d.display_name("u-bob").as_deref(), Some("bob"));
    let expired = json!({"id": "u-x", "username": "x", "props": {"customStatus": "{\"emoji\":\"palm_tree\",\"expires_at\":\"2001-01-01T00:00:00Z\"}"}});
    d.remember(User::from_json(&expired).unwrap());
    assert_eq!(d.status_emoji("u-x"), None);
}

#[tokio::test]
async fn kchat_calls_open_kmeet_with_their_jwt_only() {
    let url = std::sync::Arc::new(std::sync::Mutex::new("https://kmeet.infomaniak.com/room".to_owned()));
    let shared = url.clone();
    let server = FakeHttp::start(move |r| match r.path() {
        "/api/v4/conferences" | "/api/v4/conferences/c1/answer" => {
            respond(200, &json!({"id": "c1", "url": *shared.lock().unwrap(), "jwt": "j w"}).to_string())
        }
        _ => respond(404, "{}"),
    })
    .await;
    let rest = RestClient::mattermost(server.url.clone());
    assert_eq!(actions::start_conference(&rest, "room").await.unwrap(), "https://kmeet.infomaniak.com/room?jwt=j+w");
    assert_eq!(actions::answer_conference(&rest, "c1").await.unwrap(), "https://kmeet.infomaniak.com/room?jwt=j+w");
    *url.lock().unwrap() = "https://evil.example/room".into();
    assert!(actions::answer_conference(&rest, "c1").await.is_err());
}

#[tokio::test]
async fn conversation_list_settings_come_from_the_account() {
    let server = FakeHttp::start(|r| match r.path() {
        "/api/v4/config/client" => {
            respond(200, r#"{"TeammateNameDisplay": "username", "LockTeammateNameDisplay": "true"}"#)
        }
        "/api/v4/users/me/preferences" => respond(
            200,
            r#"[{"category": "display_settings", "name": "name_format", "value": "full_name"},
                {"category": "sidebar_settings", "name": "limit_visible_dms_gms", "value": "20"}]"#,
        ),
        _ => respond(404, "{}"),
    })
    .await;
    let settings = actions::sidebar_settings(&RestClient::mattermost(server.url.clone())).await.unwrap();
    assert_eq!(
        (settings.name_format, settings.name_locked, settings.dm_limit),
        (rv_core::mattermost::directory::NameFormat::Username, true, 20)
    );
}
