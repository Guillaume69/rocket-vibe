//! A Rocket.Chat room's members, their roles and its settings, against a
//! fake server: paging and search, the role routes per room type, refusals,
//! and a settings save carrying only what changed.
mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{FakeHttp, Request, Response, dropped, respond};
use rv_core::members::{MemberList, MemberRights, Role, RoomSettings};
use rv_core::session::{Session, SessionInfo};
use serde_json::{Value, json};

const ROOMS: &str = r#"{"success":true,"update":[
    {"_id":"c1","t":"c","name":"dev","_updatedAt":"2026-10-01T10:00:00.000Z"},
    {"_id":"p1","t":"p","name":"team","_updatedAt":"2026-10-01T10:00:00.000Z"},
    {"_id":"d1","t":"d","usernames":["me","bob"],"_updatedAt":"2026-10-01T10:00:00.000Z"}
],"remove":[]}"#;

/// I am a moderator in p1 (room role), a plain user elsewhere.
const SUBSCRIPTIONS: &str = r#"{"success":true,"update":[
    {"_id":"s1","rid":"c1","t":"c","name":"dev","open":true,"_updatedAt":"2026-10-01T10:00:00.000Z"},
    {"_id":"s2","rid":"p1","t":"p","name":"team","open":true,"roles":["moderator"],"_updatedAt":"2026-10-01T10:00:00.000Z"}
],"remove":[]}"#;

const PERMISSIONS: &str = r#"{"success":true,"update":[
    {"_id":"set-moderator","roles":["admin","owner"]},
    {"_id":"set-owner","roles":["admin","owner"]},
    {"_id":"remove-user","roles":["admin","owner","moderator"]},
    {"_id":"edit-room","roles":["admin","owner","moderator"]},
    {"_id":"post-readonly","roles":["admin","owner","moderator"]}
],"remove":[]}"#;

fn member(i: u32) -> Value {
    json!({"_id": format!("u{i}"), "username": format!("user{i}"), "name": format!("User {i}"), "status": "online", "roles": []})
}

fn server(request: &Request) -> Response {
    let path = request.path();
    if path.ends_with("/websocket") {
        return dropped();
    }
    match path.trim_start_matches("/api/v1/") {
        "rooms.get" => respond(200, ROOMS),
        "subscriptions.get" => respond(200, SUBSCRIPTIONS),
        "permissions.listAll" => respond(200, PERMISSIONS),
        "me" => respond(200, r#"{"success":true,"_id":"u-me","username":"me","roles":["user"]}"#),
        "rooms.membersOrderedByRole" => {
            let offset: u32 = request
                .target
                .split(['?', '&'])
                .find_map(|p| p.strip_prefix("offset="))
                .and_then(|o| o.parse().ok())
                .unwrap_or(0);
            // 60 members: a full page, then 10; past the end, nothing.
            let members: Vec<Value> = (offset..60.min(offset + 50)).map(member).collect();
            respond(200, &json!({"success": true, "members": members, "total": 60, "offset": offset}).to_string())
        }
        "groups.addOwner" => respond(
            400,
            r#"{"success":false,"error":"User is already an owner [error-user-already-owner]","errorType":"error-user-already-owner"}"#,
        ),
        "groups.removeOwner" => respond(
            400,
            r#"{"success":false,"error":"This is the last owner. [error-remove-last-owner]","errorType":"error-remove-last-owner"}"#,
        ),
        "channels.addModerator" => respond(
            400,
            r#"{"success":false,"error":"Not allowed [error-not-allowed]","errorType":"error-not-allowed"}"#,
        ),
        "rooms.saveRoomSettings" if request.body.contains("roomAvatar") && request.body.contains("c1") => {
            respond(403, r#"{"success":false,"error":"Not allowed","errorType":"error-not-allowed"}"#)
        }
        _ => respond(200, r#"{"success":true}"#),
    }
}

struct Bench {
    server: FakeHttp,
    session: Arc<Session>,
    _dir: tempfile::TempDir,
}

async fn bench() -> Bench {
    let server = FakeHttp::start(server).await;
    let dir = tempfile::tempdir().unwrap();
    let info = SessionInfo {
        base_url: server.url.to_string(),
        user_id: "u-me".into(),
        username: "me".into(),
        auth_token: "tok".into(),
        native: None,
        mattermost: None,
    };
    let session = Session::start(info, &dir.path().join("account.sqlite")).unwrap();
    for _ in 0..100 {
        if session.store.room_kind("d1").is_some() && !session.store.room_roles("p1").is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(session.members_available("c1") && session.members_available("p1"), "rooms listed");
    Bench { server, session, _dir: dir }
}

impl Bench {
    /// The (path, query, body) of the requests on `route` since `from`.
    fn calls(&self, from: usize, route: &str) -> Vec<(String, Value)> {
        self.server.requests()[from..]
            .iter()
            .filter(|r| r.path().ends_with(route))
            .map(|r| (r.target.clone(), serde_json::from_str(&r.body).unwrap_or(Value::Null)))
            .collect()
    }

    fn close(self) {
        self.session.shutdown();
        self.session.store.close();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn members_are_read_by_page_and_searched_by_the_server() {
    let b = bench().await;
    let s = b.session.clone();
    let from = b.server.requests().len();
    let mut list = MemberList::first(s.room_members("c1", "", 0).await.unwrap());
    assert_eq!((list.members.len(), list.total), (50, 60));
    assert!(list.has_more());
    list.append(s.room_members("c1", "", list.offset()).await.unwrap());
    assert_eq!(list.members.len(), 60);
    assert!(!list.has_more(), "all read");
    s.room_members("p1", "  bo ", 0).await.unwrap();

    let targets: Vec<String> = b.calls(from, "rooms.membersOrderedByRole").into_iter().map(|(t, _)| t).collect();
    assert_eq!(
        targets,
        [
            "/api/v1/rooms.membersOrderedByRole?roomId=c1&count=50&offset=0",
            "/api/v1/rooms.membersOrderedByRole?roomId=c1&count=50&offset=50",
            "/api/v1/rooms.membersOrderedByRole?roomId=p1&count=50&offset=0&filter=bo",
        ]
    );
    // Neither a DM nor an unknown room asks the server.
    let before = b.server.requests().len();
    assert!(s.room_members("d1", "", 0).await.is_err());
    assert!(s.room_members("nowhere", "", 0).await.is_err());
    assert!(!s.members_available("d1"));
    assert!(b.calls(before, "rooms.membersOrderedByRole").is_empty());
    b.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn role_calls_follow_the_room_type() {
    let b = bench().await;
    let s = b.session.clone();
    let from = b.server.requests().len();
    s.set_member_role("p1", "u2", Role::Moderator, true).await.unwrap();
    s.set_member_role("p1", "u2", Role::Moderator, false).await.unwrap();
    s.remove_member("c1", "u3").await.unwrap();
    s.remove_member("p1", "u3").await.unwrap();
    s.set_member_role("c1", "u2", Role::Owner, true).await.unwrap();

    let calls: Vec<(String, Value)> = b.server.requests()[from..]
        .iter()
        .filter(|r| r.method == "POST")
        .map(|r| (r.path().to_owned(), serde_json::from_str(&r.body).unwrap()))
        .collect();
    let user = |u: &str, room: &str| json!({"roomId": room, "userId": u});
    assert_eq!(
        calls,
        [
            ("/api/v1/groups.addModerator".to_owned(), user("u2", "p1")),
            ("/api/v1/groups.removeModerator".to_owned(), user("u2", "p1")),
            ("/api/v1/channels.kick".to_owned(), user("u3", "c1")),
            ("/api/v1/groups.kick".to_owned(), user("u3", "p1")),
            ("/api/v1/channels.addOwner".to_owned(), user("u2", "c1")),
        ]
    );
    let before = b.server.requests().len();
    assert!(s.set_member_role("d1", "u2", Role::Owner, true).await.is_err(), "no roles in a DM");
    assert!(s.remove_member("d1", "u2").await.is_err());
    assert_eq!(b.server.requests().len(), before, "refused before any call");
    b.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refusals_say_why_unless_already_done() {
    let b = bench().await;
    let s = b.session.clone();
    // Already an owner: the change is in place.
    s.set_member_role("p1", "u2", Role::Owner, true).await.unwrap();
    let last = s.set_member_role("p1", "u-me", Role::Owner, false).await.unwrap_err();
    assert_eq!(rv_core::members::error_key(&last), "members.last_owner");
    let refused = s.set_member_role("c1", "u2", Role::Moderator, true).await.unwrap_err();
    assert_eq!((refused.status, rv_core::members::error_key(&refused)), (400, "members.action_failed"));
    b.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rights_come_from_my_global_and_room_roles() {
    let b = bench().await;
    let s = b.session.clone();
    // A plain user in c1; a moderator in p1 removes and edits, but names nobody.
    assert_eq!(s.member_rights("c1").await, MemberRights::default());
    assert!(!s.can_edit_room("c1").await);
    assert_eq!(s.member_rights("p1").await, MemberRights { moderator: false, owner: false, remove: true });
    assert!(s.can_edit_room("p1").await);
    assert!(!s.can_edit_room("d1").await);
    // Writing on in a read-only room: a moderator of p1 may, a plain user of c1 not.
    assert!(s.may_post_read_only("p1").await);
    assert!(!s.may_post_read_only("c1").await);
    b.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settings_send_only_what_changed() {
    let b = bench().await;
    let s = b.session.clone();
    let before =
        RoomSettings { topic: "Old".into(), description: "Same".into(), announcement: "Hi".into(), read_only: false };
    let from = b.server.requests().len();
    assert!(!s.save_room_settings("p1", &before, &before.clone()).await.unwrap(), "nothing to send");
    assert!(b.calls(from, "rooms.saveRoomSettings").is_empty());

    let after = RoomSettings { topic: "New".into(), announcement: String::new(), read_only: true, ..before.clone() };
    assert!(s.save_room_settings("p1", &before, &after).await.unwrap());
    let sent = b.calls(from, "rooms.saveRoomSettings");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].1, json!({"rid": "p1", "roomTopic": "New", "roomAnnouncement": "", "readOnly": true}));
    b.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn channel_images_send_a_data_uri_and_refresh_without_a_stream_event() {
    let b = bench().await;
    let image = b._dir.path().join("channel.png");
    std::fs::write(&image, b"image bytes").unwrap();
    let from = b.server.requests().len();
    let path = b.session.set_room_avatar("p1", &image, "image/png").await.unwrap();
    assert_eq!(
        b.calls(from, "rooms.saveRoomSettings")[0].1,
        json!({"rid":"p1", "roomAvatar":"data:image/png;base64,aW1hZ2UgYnl0ZXM="})
    );
    let room = b.session.store.rooms().into_iter().find(|r| r.rid == "p1").unwrap();
    assert!(room.avatar_etag.as_deref().unwrap().starts_with("rv-local-"));
    assert_eq!(rv_core::media::room_avatar_path(&room), Some(path));
    assert!(b.session.set_room_avatar("c1", &image, "image/png").await.is_err());
    assert!(b.session.store.rooms().iter().find(|r| r.rid == "c1").unwrap().avatar_etag.is_none());
    let from = b.server.requests().len();
    assert!(b.session.set_room_avatar("d1", &image, "image/png").await.is_err());
    assert!(b.session.set_room_avatar("p1", &image, "text/plain").await.is_err());
    assert!(b.calls(from, "rooms.saveRoomSettings").is_empty());
    b.close();
}
