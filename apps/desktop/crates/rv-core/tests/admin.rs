mod common;

use common::{FakeHttp, respond};
use rv_core::admin::{AdminError, LastOwner, Presence, RoomType, rc};
use rv_core::rest::{Credentials, RestClient};
use serde_json::{Value, json};

fn client(server: &FakeHttp) -> RestClient {
    let c = RestClient::new(server.url.clone());
    c.set_credentials(Some(Credentials { auth_token: "tok".into(), user_id: "admin-id".into() }));
    c
}

fn sent(server: &FakeHttp, path: &str) -> Vec<(String, Value)> {
    server
        .requests()
        .into_iter()
        .filter(|r| r.path() == path)
        .map(|r| (r.target.clone(), serde_json::from_str(&r.body).unwrap_or(Value::Null)))
        .collect()
}

#[tokio::test]
async fn rocket_chat_lists_page_by_offset_and_search() {
    let server = FakeHttp::start(|r| match r.path() {
        "/api/v1/users.listByStatus" => respond(
            200,
            &json!({"success": true, "total": 51, "offset": 0, "count": 2, "users": [
                {"_id": "a1", "username": "admin", "name": "Admin", "roles": ["admin"], "active": true, "type": "user",
                 "status": "online", "lastLogin": "2026-10-07T19:01:19.704Z"},
                {"_id": "b1", "username": "rocket.cat", "name": "Rocket.Cat", "roles": ["bot"], "active": false, "type": "bot",
                 "status": "offline", "avatarETag": "e1"}
            ]})
            .to_string(),
        ),
        "/api/v1/rooms.adminRooms" => respond(
            200,
            &json!({"success": true, "total": 3, "rooms": [
                {"_id": "r1", "t": "c", "name": "general", "fname": "General", "msgs": 30, "usersCount": 4, "ro": true, "ts": "2026-10-06T20:27:05.446Z"},
                {"_id": "r2", "t": "d", "usernames": ["alice", "bob"], "msgs": 12, "usersCount": 2},
                {"_id": "r3", "t": "p", "prid": "r1", "fname": "A discussion", "msgs": 1, "usersCount": 1}
            ]})
            .to_string(),
        ),
        _ => respond(404, r#"{"success":false}"#),
    })
    .await;
    let c = client(&server);
    let users = rc::users(&c, 0, " ali ").await.unwrap();
    assert_eq!(users.next.as_deref(), Some("2"));
    assert!(users.items[0].admin && users.items[0].active && users.items[0].status == Presence::Online);
    assert_eq!(users.items[0].last_seen_at.as_deref(), Some("2026-10-07T19:01:19.704Z"));
    assert_eq!(users.items[0].avatar, None, "no avatarETag: no photo");
    assert!(users.items[1].bot && !users.items[1].active && users.items[1].avatar.as_deref() == Some("e1"));
    assert_eq!(
        sent(&server, "/api/v1/users.listByStatus")[0].0,
        "/api/v1/users.listByStatus?count=50&offset=0&searchTerm=ali"
    );
    let rooms = rc::rooms(&c, 0, "gen").await.unwrap();
    assert_eq!(rooms.next, None, "every room on this page");
    assert_eq!(
        (rooms.items[0].kind, rooms.items[0].name.as_str(), rooms.items[0].read_only),
        (RoomType::Public, "General", true)
    );
    assert_eq!((rooms.items[1].kind, rooms.items[1].name.as_str()), (RoomType::Direct, "alice, bob"));
    assert_eq!(rooms.items[2].kind, RoomType::Discussion);
    assert_eq!(
        sent(&server, "/api/v1/rooms.adminRooms")[0].0,
        "/api/v1/rooms.adminRooms?count=50&offset=0&types%5B%5D=c&types%5B%5D=p&types%5B%5D=d\
         &types%5B%5D=discussions&types%5B%5D=teams&filter=gen",
        "every type named, or discussions and teams are hidden"
    );
}

#[tokio::test]
async fn rocket_chat_moderation_counts_each_message_reports() {
    let server = FakeHttp::start(|r| match r.path() {
        "/api/v1/moderation.reportsByUsers" => respond(
            200,
            &json!({"success": true, "total": 21, "reports": [
                {"userId": "u1", "username": "spammer", "name": "Spammer", "isUserDeleted": false, "count": 3},
                {"userId": "u9", "username": "gone", "name": "Gone", "isUserDeleted": true, "count": 1}
            ]})
            .to_string(),
        ),
        // One entry per message (deduplicated); `count` counts the author's reports.
        "/api/v1/moderation.user.reportedMessages" if r.target.contains("userId=u1") => respond(
            200,
            &json!({"success": true, "total": 2, "messages": [
                {"_id": "rep2", "ts": "2026-10-07T11:00:00.000Z", "room": {"_id": "R1", "t": "c", "name": "general", "fname": "General"},
                 "message": {"_id": "M1", "msg": "buy now", "ts": "2026-10-07T09:00:00.000Z"}},
                {"_id": "rep3", "ts": "2026-10-07T08:00:00.000Z", "room": {"_id": "R2", "t": "p", "name": "secret"},
                 "message": {"_id": "M2", "msg": "ciphertext", "t": "e2e", "ts": "2026-10-07T07:00:00.000Z"}}
            ]})
            .to_string(),
        ),
        "/api/v1/moderation.user.reportedMessages" => respond(
            200,
            &json!({"success": true, "total": 1, "messages": [
                {"_id": "rep9", "ts": "2026-10-07T06:00:00.000Z", "room": {"_id": "R1", "t": "c", "name": "general"},
                 "message": {"_id": "M9", "msg": "old", "ts": "2026-10-07T05:00:00.000Z"}}
            ]})
            .to_string(),
        ),
        "/api/v1/moderation.reports" if r.target.contains("count=1") => {
            let total = if r.target.contains("msgId=M1") { 2 } else { 1 };
            respond(200, &json!({"success": true, "total": total, "reports": []}).to_string())
        }
        "/api/v1/moderation.reports" => respond(
            200,
            &json!({"success": true, "reports": [
                {"description": "spam", "reportedBy": {"_id": "a", "username": "alice", "name": "Alice"}, "ts": "2026-10-07T10:00:00.000Z"},
                {"description": "ads", "reportedBy": {"_id": "b", "username": "bob", "name": "Bob"}, "ts": "2026-10-07T11:00:00.000Z"}
            ]})
            .to_string(),
        ),
        "/api/v1/moderation.userReports" => respond(
            200,
            &json!({"success": true, "total": 1, "reports": [
                {"reportedUser": {"_id": "u2", "username": "bob", "name": "Bob", "createdAt": "2026-10-06T20:27:05.300Z"},
                 "count": 2, "ts": "2026-10-07T18:51:51.085Z"}
            ]})
            .to_string(),
        ),
        "/api/v1/moderation.user.reportsByUserId" => respond(
            200,
            &json!({"success": true, "user": {"_id": "u2", "username": "bob", "active": false}, "reports": [
                {"description": "rude", "reportedBy": {"_id": "a", "username": "alice", "name": "Alice"}, "ts": "2026-10-07T10:00:00.000Z"}
            ]})
            .to_string(),
        ),
        _ => respond(200, r#"{"success":true}"#),
    })
    .await;
    let c = client(&server);
    let page = rc::reported_messages(&c, 0).await.unwrap();
    assert_eq!(page.items.len(), 3);
    assert_eq!(page.next.as_deref(), Some("2"), "the next authors");
    let first = &page.items[0];
    assert_eq!(
        (first.message_id.as_str(), first.count, first.latest_at.as_str()),
        ("M1", 2, "2026-10-07T11:00:00.000Z"),
        "the message's own report count, not the author's"
    );
    assert_eq!((first.room.name.as_str(), first.author.username.as_str()), ("General", "spammer"));
    let encrypted = page.items.iter().find(|m| m.message_id == "M2").unwrap();
    assert!(encrypted.encrypted && encrypted.text.is_empty(), "an encrypted message is never shown");
    assert_eq!((encrypted.room.kind, encrypted.count), (RoomType::Private, 1));
    let gone = page.items.iter().find(|m| m.message_id == "M9").unwrap();
    assert!(gone.author.deleted);
    assert_eq!(
        sent(&server, "/api/v1/moderation.reportsByUsers")[0].0,
        "/api/v1/moderation.reportsByUsers?count=20&offset=0"
    );
    let reasons = rc::message_reports(&c, "M1").await.unwrap();
    assert_eq!((reasons[0].reason.as_str(), reasons[0].reporter.name.as_str()), ("ads", "Bob"), "newest first");
    let users = rc::reported_users(&c, 0).await.unwrap();
    assert_eq!((users.items[0].user.username.as_str(), users.items[0].count, users.items[0].active), ("bob", 2, None));
    let details = rc::user_reports(&c, "u2").await.unwrap();
    assert_eq!((details.reports[0].reason.as_str(), details.active), ("rude", Some(false)));

    rc::dismiss_message(&c, "M1").await.unwrap();
    rc::delete_message(&c, "R1", "M1").await.unwrap();
    rc::delete_author_reported_messages(&c, "u1").await.unwrap();
    rc::dismiss_user(&c, "u2").await.unwrap();
    rc::set_admin(&c, "bob", true).await.unwrap();
    rc::set_admin(&c, "bob", false).await.unwrap();
    rc::set_active(&c, "u2", false, false).await.unwrap();
    rc::set_active(&c, "u2", false, true).await.unwrap();
    rc::delete_user(&c, "u2", false).await.unwrap();
    rc::delete_user(&c, "u2", true).await.unwrap();
    rc::report_message(&c, "M1", "spam").await.unwrap();
    rc::report_user(&c, "u2", "rude").await.unwrap();
    assert_eq!(sent(&server, "/api/v1/moderation.dismissReports")[0].1, json!({"msgId": "M1"}));
    assert_eq!(sent(&server, "/api/v1/chat.delete")[0].1, json!({"roomId": "R1", "msgId": "M1"}));
    assert_eq!(sent(&server, "/api/v1/moderation.user.deleteReportedMessages")[0].1, json!({"userId": "u1"}));
    assert_eq!(sent(&server, "/api/v1/moderation.dismissUserReports")[0].1, json!({"userId": "u2"}));
    assert_eq!(sent(&server, "/api/v1/roles.addUserToRole")[0].1, json!({"roleId": "admin", "username": "bob"}));
    assert_eq!(sent(&server, "/api/v1/roles.removeUserFromRole")[0].1, json!({"roleId": "admin", "username": "bob"}));
    let active = sent(&server, "/api/v1/users.setActiveStatus");
    assert_eq!(active[0].1, json!({"userId": "u2", "activeStatus": false}), "asked first without relinquishing");
    assert_eq!(active[1].1, json!({"userId": "u2", "activeStatus": false, "confirmRelinquish": true}));
    let deleted = sent(&server, "/api/v1/users.delete");
    assert_eq!(deleted[0].1, json!({"userId": "u2"}));
    assert_eq!(deleted[1].1, json!({"userId": "u2", "confirmRelinquish": true}));
    assert_eq!(sent(&server, "/api/v1/chat.reportMessage")[0].1, json!({"messageId": "M1", "description": "spam"}));
    assert_eq!(sent(&server, "/api/v1/moderation.reportUser")[0].1, json!({"userId": "u2", "description": "rude"}));
}

#[tokio::test]
async fn rocket_chat_last_owner_and_unreachable_rooms_ask_again() {
    let server = FakeHttp::start(|r| match r.path() {
        "/api/v1/users.setActiveStatus" if !r.body.contains("confirmRelinquish") => respond(
            400,
            r#"{"success":false,"errorType":"user-last-owner","error":"user-last-owner",
                "details":{"shouldBeRemoved":["solo"],"shouldChangeOwner":["shared"]}}"#,
        ),
        "/api/v1/chat.delete" => respond(
            400,
            r#"{"success":false,"errorType":"error-action-not-allowed","error":"Not allowed [error-action-not-allowed]"}"#,
        ),
        "/api/v1/moderation.user.reportedMessages" => respond(200, r#"{"success":true,"total":4,"messages":[]}"#),
        _ => respond(200, r#"{"success":true}"#),
    })
    .await;
    let c = client(&server);
    let refused = AdminError::from(rc::set_active(&c, "u2", false, false).await.unwrap_err());
    assert_eq!(refused.code, "user-last-owner");
    assert_eq!(
        refused.last_owner,
        Some(LastOwner { removed: vec!["solo".into()], transferred: vec!["shared".into()] })
    );
    rc::set_active(&c, "u2", false, true).await.unwrap();
    let delete = rc::delete_message(&c, "D1", "M1").await.unwrap_err();
    assert_eq!(delete.error_type.as_deref(), Some("error-action-not-allowed"));
    assert_eq!(rc::author_reported_count(&c, "u1").await.unwrap(), 4);
}

#[tokio::test]
async fn rocket_chat_overview_reads_the_snapshot_and_survives_refusals() {
    let server = FakeHttp::start(|r| match r.path() {
        "/api/v1/statistics" => respond(
            200,
            r#"{"success":true,"version":"8.5.1","totalUsers":4,"activeUsers":3,"createdAt":"2026-10-07T18:00:00.000Z"}"#,
        ),
        "/api/v1/roles.getUsersInRole" => respond(200, r#"{"success":true,"total":1,"users":[]}"#),
        "/api/v1/moderation.reportsByUsers" => {
            respond(403, r#"{"success":false,"error":"User does not have the permissions","errorType":"error-unauthorized"}"#)
        }
        "/api/v1/moderation.userReports" => respond(200, r#"{"success":true,"total":1,"reports":[]}"#),
        _ => respond(404, r#"{"success":false}"#),
    })
    .await;
    let c = client(&server);
    let overview = rc::overview(&c, false).await.unwrap();
    assert_eq!((overview.version.as_str(), overview.users.total, overview.users.admins), ("8.5.1", 4, Some(1)));
    assert_eq!(
        (overview.reports.messages, overview.reports.users),
        (None, Some(1)),
        "a refusal leaves one figure unknown"
    );
    assert_eq!(overview.as_of.as_deref(), Some("2026-10-07T18:00:00.000Z"));
    assert_eq!(sent(&server, "/api/v1/statistics")[0].0, "/api/v1/statistics", "the snapshot, no aggregation");
    rc::overview(&c, true).await.unwrap();
    assert_eq!(sent(&server, "/api/v1/statistics")[1].0, "/api/v1/statistics?refresh=true");
}

#[tokio::test]
async fn rocket_chat_open_reports_add_up_the_authors_counts() {
    let server = FakeHttp::start(|r| match r.path() {
        "/api/v1/statistics" => respond(200, r#"{"success":true,"version":"8.5.1"}"#),
        "/api/v1/moderation.reportsByUsers" => respond(
            200,
            r#"{"success":true,"total":2,"reports":[{"userId":"u1","count":7},{"userId":"u2","count":1}]}"#,
        ),
        "/api/v1/moderation.userReports" => respond(200, r#"{"success":true,"total":0,"reports":[]}"#),
        _ => respond(404, r#"{"success":false}"#),
    })
    .await;
    let overview = rc::overview(&client(&server), false).await.unwrap();
    assert_eq!(overview.reports.messages, Some(8), "the reports, not the 2 authors");
    assert_eq!(sent(&server, "/api/v1/moderation.reportsByUsers")[0].0, "/api/v1/moderation.reportsByUsers?count=100");
}
