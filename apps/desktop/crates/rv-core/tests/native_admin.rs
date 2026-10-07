mod common;
use common::{FakeHttp, respond};
use rv_core::{
    admin::{Admin, Presence, RoomType},
    native::{self, Identity},
    session::{Connection, SessionInfo},
};
use serde_json::json;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[tokio::test]
async fn native_administration_maps_the_contract_and_sends_operations() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let admin = Arc::new(AtomicBool::new(true));
    let bodies = Arc::new(Mutex::new(Vec::<(String, String, serde_json::Value)>::new()));
    let (responses, manager, log) = (fixture.clone(), admin.clone(), bodies.clone());
    let server = FakeHttp::start(move |request| {
        if request.method != "GET" {
            let body = serde_json::from_str(&request.body).unwrap_or(serde_json::Value::Null);
            log.lock().unwrap().push((request.method.clone(), request.path().to_owned(), body));
        }
        let administration = &responses["administration"];
        match request.path() {
            "/.well-known/rocketvibe" => {
                let mut discovery = responses["discovery"].clone();
                discovery["capabilities"]["administration"] = json!(true);
                discovery["capabilities"]["reports"] = json!(true);
                respond(200, &discovery.to_string())
            }
            "/api/v1/me" => respond(200, &responses["session"]["user"].to_string()),
            "/api/v1/me/permissions" => {
                let mut permissions = responses["parity"]["account_permissions"].clone();
                permissions["manage_accounts"] = json!(manager.load(Ordering::SeqCst));
                respond(200, &permissions.to_string())
            }
            "/api/v1/sync/changes" => respond(
                200,
                &json!({"protocol_version":1,"changes":[],"cursor":"initial","has_more":false}).to_string(),
            ),
            "/api/v1/sync/ticket" => respond(200, &responses["socket_ticket"].to_string()),
            "/api/v1/sync/socket" => common::Response { websocket: true, ..Default::default() },
            "/api/v1/admin/overview" => respond(200, &administration["overview"].to_string()),
            "/api/v1/admin/users" => respond(200, &administration["user_page"].to_string()),
            "/api/v1/admin/rooms" => respond(200, &administration["room_page"].to_string()),
            "/api/v1/admin/reports/messages" => respond(200, &administration["reported_messages"].to_string()),
            "/api/v1/admin/reports/users" => respond(200, &administration["reported_users"].to_string()),
            "/api/v1/admin/users/dave-id" if request.method == "PATCH" => {
                let mut user = administration["user_page"]["items"][1].clone();
                user["disabled"] = json!(false);
                user["revision"] = json!("dave-next");
                respond(200, &user.to_string())
            }
            "/api/v1/admin/users/bob-id" if request.method == "PATCH" => {
                respond(409, r#"{"code":"last_administrator","request_id":"fixture"}"#)
            }
            path if request.method == "POST" && (path.starts_with("/api/v1/admin/") || path.ends_with("/report")) => {
                respond(204, "")
            }
            _ => respond(404, r#"{"code":"not_found","request_id":"fixture"}"#),
        }
    })
    .await;
    let identity = Identity {
        instance_id: fixture["discovery"]["instance_id"].as_str().unwrap().into(),
        data_epoch: fixture["discovery"]["data_epoch"].as_str().unwrap().into(),
    };
    let path = std::env::temp_dir().join(format!("rv-admin-{:032x}.sqlite", fastrand::u128(..)));
    let store = native::store::NativeStore::open(&path, identity.clone()).unwrap();
    store
        .snapshot(&rv_protocol::Snapshot {
            protocol_version: 1,
            rooms: vec![],
            messages: vec![],
            cursor: "initial".into(),
        })
        .unwrap();
    drop(store);
    let info = SessionInfo {
        base_url: server.url.as_str().into(),
        user_id: fixture["session"]["user"]["id"].as_str().unwrap().into(),
        username: "alice".into(),
        auth_token: "fixture-token".into(),
        native: Some(identity),
    };
    let session = native::NativeSession::start(info, &path).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.status().connection != Connection::Online {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let features = session.supported_features();
    assert!(features.iter().any(|f| f == "administration") && features.iter().any(|f| f == "reports"));
    let provider = Admin::Native(session.clone());
    assert!(provider.is_admin().await && provider.reports_supported());
    admin.store(false, Ordering::SeqCst);
    assert!(!provider.is_admin().await, "a member without account rights sees no administration");

    let overview = provider.overview(false).await.unwrap();
    assert_eq!((overview.version.as_str(), overview.users.admins, overview.reports.users), ("0.1.0", Some(2), Some(1)));
    let users = provider.users(None, " bo ").await.unwrap();
    assert!(users.next.is_some(), "an opaque cursor to the next page");
    let (bob, dave) = (&users.items[0], &users.items[1]);
    assert_eq!((bob.status, bob.revision.as_deref()), (Presence::Busy, Some("bob-activation")));
    assert!(dave.admin && !dave.active);
    let activated = provider.set_active(dave, true, false).await.unwrap();
    assert!(activated.active && activated.revision.as_deref() == Some("dave-next"));
    assert_eq!(provider.set_admin(bob, true).await.unwrap_err().code, "last_administrator");
    provider.delete_user(dave, false).await.unwrap();
    let me = rv_core::admin::AdminUser { id: provider.my_id().into(), ..Default::default() };
    assert_eq!(provider.delete_user(&me, false).await.unwrap_err().code, "self_administration");

    let rooms = provider.rooms(None, "").await.unwrap();
    assert_eq!((rooms.items[1].kind, rooms.items[1].direct_members.len()), (RoomType::Direct, 2));
    let reported = provider.reported_messages(None).await.unwrap();
    let message = &reported.items[0];
    assert!(message.author.deleted);
    assert_eq!(provider.message_reports(message).await.unwrap()[0].reason, "Spam");
    provider.dismiss_message_reports(message).await.unwrap();
    provider.delete_reported_message(message).await.unwrap();
    assert_eq!(provider.deactivate_author(message, false).await.unwrap_err().code, "not_found", "a deleted author");
    // The author's revision comes with the report: no search of the users list.
    let _ = provider.deactivate_author(&reported.items[1], false).await;
    let accounts = provider.reported_users(None).await.unwrap();
    assert_eq!(provider.user_reports(&accounts.items[0]).await.unwrap().reports[0].reason, "Insults in DMs");
    provider.dismiss_user_reports(&accounts.items[0]).await.unwrap();
    provider.report_message("message-id", "  Spam  ").await.unwrap();
    provider.report_user("bob-id", "Rude").await.unwrap();
    assert_eq!(provider.report_user(provider.my_id(), "Me").await.unwrap_err().code, "self_report");
    assert_eq!(provider.report_message("message-id", "   ").await.unwrap_err().code, "invalid_reason");

    let sent = bodies.lock().unwrap().clone();
    let find = |path: &str| sent.iter().find(|(_, p, _)| p == path).map(|(m, _, b)| (m.clone(), b.clone())).unwrap();
    let author = sent.iter().rev().find(|(_, p, _)| p == "/api/v1/admin/users/bob-id").map(|(_, _, b)| b).unwrap();
    assert_eq!((author["revision"].as_str(), author["disabled"].as_bool()), (Some("bob-activation"), Some(true)));
    let (method, body) = find("/api/v1/admin/users/dave-id");
    assert_eq!(method, "PATCH");
    assert_eq!((body["revision"].as_str(), body["disabled"].as_bool()), (Some("dave-activation"), Some(false)));
    assert!(body.get("admin").is_none() && body["operation_id"].as_str().is_some_and(|id| id.len() == 32));
    assert_eq!(find("/api/v1/admin/users/dave-id/delete").1["revision"], "dave-activation");
    assert!(find("/api/v1/admin/reports/messages/message-id/dismiss").1["operation_id"].is_string());
    assert!(find("/api/v1/admin/reports/messages/message-id/delete").1["operation_id"].is_string());
    assert!(find("/api/v1/admin/reports/users/bob-id/dismiss").1["operation_id"].is_string());
    assert_eq!(find("/api/v1/messages/message-id/report").1["reason"], "Spam");
    assert_eq!(find("/api/v1/users/bob-id/report").1["reason"], "Rude");

    session.shutdown();
    assert_eq!(provider.overview(false).await.unwrap_err().code, "session_closed");
    drop(provider);
    common::close_native(session).await;
    std::fs::remove_file(path).unwrap();
}
