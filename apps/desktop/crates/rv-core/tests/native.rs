mod common;
use common::{FakeHttp, respond};
use rv_core::native::{self, Identity};
use rv_core::session::SessionInfo;
use serde_json::json;

#[tokio::test]
async fn encrypted_room_sync_refuses_plaintext_posts_and_preserves_the_old_outbox_body() {
    use std::{sync::Arc, time::Duration};
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let mut room: rv_protocol::Room = serde_json::from_value(fixture["room"].clone()).unwrap();
    let identity = Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() };
    let path = std::env::temp_dir().join(format!("rv-encrypted-room-{:032x}.sqlite", fastrand::u128(..)));
    let store = native::store::NativeStore::open(&path, identity.clone()).unwrap();
    store
        .snapshot(&rv_protocol::Snapshot {
            protocol_version: 1,
            rooms: vec![room.clone()],
            messages: vec![],
            cursor: "initial".into(),
        })
        .unwrap();
    store.enqueue("offline-before", &room.id, "Keep the unsent body", "alice").unwrap();
    drop(store);
    room.encrypted = true;
    room.revision = (room.revision.parse::<u64>().unwrap() + 1).to_string();
    let rid = room.id.clone();
    let responses = Arc::new(fixture);
    let server = FakeHttp::start(move |request| match request.path() {
        "/.well-known/rocketvibe"=>respond(200,&responses["discovery"].to_string()),
        "/api/v1/me"=>respond(200,&responses["session"]["user"].to_string()),
        "/api/v1/sync/changes"=>respond(200,&json!({"protocol_version":1,"changes":[rv_protocol::Change::RoomUpsert(room.clone())],"cursor":"encrypted","has_more":false}).to_string()),
        "/api/v1/sync/ticket"=>respond(200,&responses["socket_ticket"].to_string()),
        "/api/v1/sync/socket"=>common::Response {websocket:true,..Default::default()},
        _=>respond(404,r#"{"code":"not_found","request_id":"fake"}"#),
    }).await;
    let session = native::NativeSession::start(
        SessionInfo {
            base_url: server.url.as_str().into(),
            user_id: "alice-id".into(),
            username: "alice".into(),
            auth_token: "fixture-token".into(),
            native: Some(identity),
        },
        &path,
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.status().connection != rv_core::session::Connection::Online {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(session.store.room_encrypted(&rid).unwrap());
    assert!(session.room_rows().unwrap().iter().find(|r| r.rid == rid).unwrap().encrypted);
    assert!(!session.can_send_to_room(&rid));
    // Still writable: through the private conversation, not the ordinary path.
    let row = session.room_rows().unwrap().into_iter().find(|r| r.rid == rid).unwrap();
    assert!(session.room_send_permitted(&rid) && !row.read_only);
    assert_eq!(session.send(&rid, "No ordinary send").err().unwrap().code(), "crypto_required");
    assert!(session.store.pending().unwrap().is_empty());
    let kept = session.store.messages(&rid, 10).unwrap();
    assert_eq!(kept[0].text, "Keep the unsent body");
    assert_eq!(kept[0].status.as_deref(), Some("failed"));
    common::close_native(session).await;
    assert!(server.requests().iter().all(|r| r.method != "POST" || !r.path().ends_with("/messages")));
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn reaction_intentions_survive_restart_and_normalize_aliases_before_retrying() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::Duration;
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let permit = Arc::new(AtomicBool::new(false));
    let confirmed = permit.clone();
    let responses = fixture.clone();
    let server = FakeHttp::start(move |request| match request.path() {
        "/.well-known/rocketvibe" => {
            let mut discovery = responses["discovery"].clone();
            discovery["capabilities"]["reactions"] = json!(true);
            respond(200, &discovery.to_string())
        }
        "/api/v1/me" => respond(200, &responses["session"]["user"].to_string()),
        "/api/v1/sync/changes" => {
            respond(200, &json!({"protocol_version":1,"changes":[],"cursor":"initial","has_more":false}).to_string())
        }
        "/api/v1/sync/ticket" => respond(200, &responses["socket_ticket"].to_string()),
        "/api/v1/sync/socket" => common::Response { websocket: true, ..Default::default() },
        "/api/v1/messages/message-id/reactions" if request.method == "PUT" => {
            if !confirmed.load(Ordering::SeqCst) {
                return respond(503, r#"{"code":"response_lost","request_id":"reaction-test"}"#);
            }
            let mut message = responses["message"].clone();
            message["revision"] = json!("9007199254740994");
            message["reactions"] = json!([{"emoji":"thumbsup","users":[responses["session"]["user"]]}]);
            respond(200, &message.to_string())
        }
        _ => respond(404, r#"{"code":"not_found","request_id":"fake"}"#),
    })
    .await;
    let identity = Identity {
        instance_id: fixture["discovery"]["instance_id"].as_str().unwrap().into(),
        data_epoch: fixture["discovery"]["data_epoch"].as_str().unwrap().into(),
    };
    let path = std::env::temp_dir().join(format!("rv-react-{:032x}.sqlite", fastrand::u128(..)));
    let store = native::store::NativeStore::open(&path, identity.clone()).unwrap();
    store
        .snapshot(&rv_protocol::Snapshot {
            protocol_version: 1,
            rooms: vec![serde_json::from_value(fixture["room"].clone()).unwrap()],
            messages: vec![serde_json::from_value(fixture["message"].clone()).unwrap()],
            cursor: "initial".into(),
        })
        .unwrap();
    drop(store);
    let info = SessionInfo {
        base_url: server.url.as_str().into(),
        user_id: "alice-id".into(),
        username: "alice".into(),
        auth_token: "fixture-token".into(),
        native: Some(identity),
    };
    let session = native::NativeSession::start(info.clone(), &path).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.status().connection != rv_core::session::Connection::Online {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    session.reconnect();
    assert_eq!(session.status().connection, rv_core::session::Connection::Connecting);
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.status().connection != rv_core::session::Connection::Online {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(session.react("room-id", "message-id", "+1", true).await.is_err());
    let command = session.store.pending_commands().unwrap().remove(0);
    assert!(session.react("room-id", "message-id", ":thumbsup:", true).await.is_err());
    assert_eq!(session.store.pending_commands().unwrap()[0].id, command.id);
    assert!(session.react("room-id", "message-id", ":thumbsup:", false).await.is_err());
    assert_eq!(session.store.pending_commands().unwrap()[0].text, command.text);
    common::close_native(session).await;
    permit.store(true, Ordering::SeqCst);
    let resumed = native::NativeSession::start(info, &path).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !resumed.store.pending_commands().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let rendered = resumed.store.messages("room-id", 10).unwrap();
    assert!(rendered[0].reactions.as_deref().unwrap().contains("alice"));
    assert!(!rendered[0].edited);
    common::close_native(resumed).await;
    let requests: Vec<_> = server
        .requests()
        .into_iter()
        .filter(|r| r.method == "PUT")
        .map(|r| serde_json::from_str::<serde_json::Value>(&r.body).unwrap())
        .collect();
    assert!(requests.len() >= 3);
    assert!(
        requests.iter().all(|input| input["operation_id"] == command.id
            && input["emoji"] == "thumbsup"
            && input["present"] == true)
    );
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn pin_and_star_intentions_survive_restart_without_becoming_toggles() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::Duration;
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    for starred in [false, true] {
        let accepted = Arc::new(AtomicBool::new(false));
        let permit = accepted.clone();
        let responses = fixture.clone();
        let server = FakeHttp::start(move |request| match request.path() {
            "/.well-known/rocketvibe" => {
                let mut discovery = responses["discovery"].clone();
                discovery["capabilities"]["pins"] = json!(true);
                discovery["capabilities"]["stars"] = json!(true);
                respond(200, &discovery.to_string())
            }
            "/api/v1/me" => respond(200, &responses["session"]["user"].to_string()),
            "/api/v1/sync/changes" => respond(
                200,
                &json!({"protocol_version":1,"changes":[],"cursor":"initial","has_more":false}).to_string(),
            ),
            "/api/v1/sync/ticket" => respond(200, &responses["socket_ticket"].to_string()),
            "/api/v1/sync/socket" => common::Response { websocket: true, ..Default::default() },
            "/api/v1/messages/message-id/pin" | "/api/v1/messages/message-id/star" if request.method == "PUT" => {
                if !permit.load(Ordering::SeqCst) {
                    return respond(503, r#"{"code":"response_lost","request_id":"mark-test"}"#);
                }
                let mut message = responses["message"].clone();
                message["pinned"] = json!(!starred);
                message["personal_star"] = json!({"present":starred,"revision":"9007199254740994"});
                respond(200, &message.to_string())
            }
            _ => respond(404, r#"{"code":"not_found","request_id":"fake"}"#),
        })
        .await;
        let identity = Identity {
            instance_id: fixture["discovery"]["instance_id"].as_str().unwrap().into(),
            data_epoch: fixture["discovery"]["data_epoch"].as_str().unwrap().into(),
        };
        let path = std::env::temp_dir().join(format!("rv-mark-{:032x}.sqlite", fastrand::u128(..)));
        let store = native::store::NativeStore::open(&path, identity.clone()).unwrap();
        store
            .snapshot(&rv_protocol::Snapshot {
                protocol_version: 1,
                rooms: vec![serde_json::from_value(fixture["room"].clone()).unwrap()],
                messages: vec![serde_json::from_value(fixture["message"].clone()).unwrap()],
                cursor: "initial".into(),
            })
            .unwrap();
        drop(store);
        let info = SessionInfo {
            base_url: server.url.as_str().into(),
            user_id: "alice-id".into(),
            username: "alice".into(),
            auth_token: "fixture-token".into(),
            native: Some(identity),
        };
        let session = native::NativeSession::start(info.clone(), &path).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while session.status().connection != rv_core::session::Connection::Online {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(session.set_mark("room-id", "message-id", true, starred).await.is_err());
        let command = session.store.pending_commands().unwrap().remove(0);
        assert!(session.set_mark("room-id", "message-id", false, starred).await.is_err());
        assert_eq!(session.store.pending_commands().unwrap()[0].id, command.id);
        common::close_native(session).await;
        accepted.store(true, Ordering::SeqCst);
        let resumed = native::NativeSession::start(info, &path).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !resumed.store.pending_commands().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let rendered = resumed.store.messages("room-id", 10).unwrap();
        assert_eq!(rendered[0].pinned, !starred);
        assert_eq!(rendered[0].starred, starred);
        common::close_native(resumed).await;
        let requests: Vec<_> = server
            .requests()
            .into_iter()
            .filter(|r| r.method == "PUT")
            .map(|r| serde_json::from_str::<serde_json::Value>(&r.body).unwrap())
            .collect();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|input| input["operation_id"] == command.id && input["present"] == true));
        std::fs::remove_file(path).unwrap();
    }
}

#[tokio::test]
async fn message_commands_survive_restart_with_the_original_revision_and_reject_closed_sessions() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::Duration;
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let confirm = Arc::new(AtomicBool::new(false));
    let permit = confirm.clone();
    let responses = fixture.clone();
    let server = FakeHttp::start(move |request| match request.path() {
        "/.well-known/rocketvibe" => {
            let mut discovery = responses["discovery"].clone();
            for feature in ["editing", "deletion", "fine_permissions"] {
                discovery["capabilities"][feature] = json!(true);
            }
            respond(200, &discovery.to_string())
        }
        "/api/v1/me" => respond(200, &responses["session"]["user"].to_string()),
        "/api/v1/sync/changes" => {
            respond(200, &json!({"protocol_version":1,"changes":[],"cursor":"initial","has_more":false}).to_string())
        }
        "/api/v1/sync/ticket" => respond(200, &responses["socket_ticket"].to_string()),
        "/api/v1/sync/socket" => common::Response { websocket: true, ..Default::default() },
        "/api/v1/messages/message-id" if request.method == "PATCH" => {
            if !permit.load(Ordering::SeqCst) {
                return respond(503, r#"{"code":"response_lost","request_id":"command-test"}"#);
            }
            let mut message = responses["message"].clone();
            message["text"] = json!("Saved desktop edit");
            message["revision"] = json!("2");
            respond(200, &message.to_string())
        }
        _ => respond(404, r#"{"code":"not_found","request_id":"fake"}"#),
    })
    .await;
    let identity = Identity {
        instance_id: fixture["discovery"]["instance_id"].as_str().unwrap().into(),
        data_epoch: fixture["discovery"]["data_epoch"].as_str().unwrap().into(),
    };
    let path = std::env::temp_dir().join(format!("rv-command-{:032x}.sqlite", fastrand::u128(..)));
    let original: rv_protocol::Message = serde_json::from_value(fixture["message"].clone()).unwrap();
    let mut original = original;
    original.revision = "1".into();
    let store = native::store::NativeStore::open(&path, identity.clone()).unwrap();
    store
        .snapshot(&rv_protocol::Snapshot {
            protocol_version: 1,
            rooms: vec![serde_json::from_value(fixture["room"].clone()).unwrap()],
            messages: vec![original.clone()],
            cursor: "initial".into(),
        })
        .unwrap();
    drop(store);
    let info = SessionInfo {
        base_url: server.url.as_str().into(),
        user_id: "alice-id".into(),
        username: "alice".into(),
        auth_token: "fixture-token".into(),
        native: Some(identity),
    };
    let session = native::NativeSession::start(info.clone(), &path).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.status().connection != rv_core::session::Connection::Online {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(session.edit("room-id", "message-id", "1", "Saved desktop edit").await.is_err());
    let command = session.store.pending_commands().unwrap().remove(0);
    let mut journal = original;
    journal.revision = "2".into();
    journal.text = "Saved desktop edit".into();
    session
        .store
        .batch(&rv_protocol::SyncBatch {
            protocol_version: 1,
            changes: vec![rv_protocol::Change::MessageUpsert(journal)],
            cursor: "edited".into(),
            has_more: false,
        })
        .unwrap();
    session.shutdown();
    assert_eq!(session.send("room-id", "Stale callback").unwrap_err().code(), "session_closed");
    assert_eq!(session.delete("room-id", "message-id", "2").await.unwrap_err().code(), "session_closed");
    common::close_native(session).await;
    confirm.store(true, Ordering::SeqCst);
    let resumed = native::NativeSession::start(info, &path).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !resumed.store.pending_commands().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(resumed.store.messages("room-id", 50).unwrap()[0].text, "Saved desktop edit");
    common::close_native(resumed).await;
    let edits: Vec<_> = server
        .requests()
        .into_iter()
        .filter(|request| request.method == "PATCH")
        .map(|request| serde_json::from_str::<serde_json::Value>(&request.body).unwrap())
        .collect();
    assert!(edits.len() >= 2);
    assert!(edits.iter().all(|input| input["operation_id"] == command.id && input["expected_revision"] == "1"));
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn room_creation_retries_a_lost_reply_with_its_durable_intention() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let replies = fixture.clone();
    let count = Arc::new(AtomicUsize::new(0));
    let attempts = count.clone();
    let server = FakeHttp::start(move |r| match r.path() {
        "/.well-known/rocketvibe" => {
            let mut d = replies["discovery"].clone();
            d["capabilities"]["idempotent_room_creation"] = json!(true);
            d["capabilities"]["room_discovery"] = json!(true);
            respond(200, &d.to_string())
        }
        "/api/v1/me" => respond(200, &replies["session"]["user"].to_string()),
        "/api/v1/users" => respond(200, &json!([replies["session"]["user"]]).to_string()),
        "/api/v1/sync/ticket" => respond(200, &replies["socket_ticket"].to_string()),
        "/api/v1/sync/socket" => common::Response { websocket: true, ..Default::default() },
        "/api/v1/sync/changes" => {
            respond(200, &json!({"protocol_version":1,"changes":[],"cursor":"initial","has_more":false}).to_string())
        }
        "/api/v1/rooms" => {
            if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                common::dropped()
            } else {
                respond(200, &replies["room"].to_string())
            }
        }
        "/api/v1/rooms/public" => respond(200, &replies["public_room_page"].to_string()),
        _ => respond(404, r#"{"code":"not_found","request_id":"fake"}"#),
    })
    .await;
    let identity = Identity { instance_id: "fixture-instance".into(), data_epoch: "fixture-epoch".into() };
    let path = std::env::temp_dir().join(format!("rv-creation-{:032x}.sqlite", fastrand::u128(..)));
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
    let session = native::NativeSession::start(
        SessionInfo {
            base_url: server.url.to_string(),
            user_id: "alice-id".into(),
            username: "alice".into(),
            auth_token: "fixture-token".into(),
            native: Some(identity),
        },
        &path,
    )
    .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while session.status().connection != rv_core::session::Connection::Online {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(session.create_room("  Durable room  ", true).await.is_err());
    assert_eq!(
        session.spotlight("Public").await.unwrap(),
        vec![rv_core::rooms::Found::Room { id: "public-room-id".into(), name: "Public room".into(), kind: "c".into() }]
    );
    assert_eq!(session.create_room("Durable room", true).await.unwrap(), "room-id");
    common::close_native(session).await;
    let requests = server.requests();
    let sends: Vec<_> = requests
        .iter()
        .filter(|r| r.path() == "/api/v1/rooms")
        .map(|r| serde_json::from_str::<serde_json::Value>(&r.body).unwrap())
        .collect();
    assert_eq!(sends.len(), 2);
    assert_eq!(sends[0]["operation_id"], sends[1]["operation_id"]);
    assert!(sends[0]["operation_id"].as_str().is_some_and(|id| !id.is_empty()));
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn official_rocket_chat_discovery_and_password_login_keep_their_original_contract() {
    let server = FakeHttp::start(|r| match r.path() {
        "/.well-known/rocketvibe" => respond(404, "{}"),
        "/api/info" => respond(200, r#"{"version":"8.5","success":true}"#),
        "/api/v1/settings.public" => respond(200, r#"{"success":true,"settings":[{"_id":"E2E_Enable","value":true}]}"#),
        "/api/v1/login" => respond(
            200,
            r#"{"status":"success","data":{"userId":"rc-user","authToken":"fixture-token","me":{"username":"alice"}}}"#,
        ),
        _ => respond(404, "{}"),
    })
    .await;
    let profile = rv_core::server::probe(&server.url).await.unwrap();
    assert_eq!(profile.genre, "rocketchat");
    assert!(profile.e2e && profile.password_login);
    let info = rv_core::session::login(&server.url, "alice", "fixture-password", None).await.unwrap();
    assert!(info.native.is_none());
    assert_eq!(info.user_id, "rc-user");
    let requests = server.requests();
    let login = requests.iter().find(|r| r.path() == "/api/v1/login").unwrap();
    assert_eq!(login.method, "POST");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&login.body).unwrap(),
        json!({"user":"alice","password":"fixture-password"})
    );
    assert!(
        requests
            .iter()
            .filter(|r| r.path() == "/.well-known/rocketvibe")
            .all(|r| r.method == "GET" && r.body.is_empty())
    );
}

#[tokio::test]
async fn native_diagnostics_survive_the_provider_error_without_treating_a_gateway_as_revocation() {
    let server = FakeHttp::start(|r| match r.path() {
        "/api/v1/users" => respond(503, r#"{"code":"service_busy","request_id":"native-request"}"#),
        "/api/v1/auth/logout" => respond(429, r#"{"code":"auth_busy","request_id":"logout-request"}"#),
        _ => respond(401, r#"{"message":"Gateway authorization required"}"#),
    })
    .await;
    let mut client = rv_client::NativeClient::new(server.url.as_str()).unwrap();
    client.restore("fixture-token".into());
    let diagnostic = native::rest_error(client.users().await.unwrap_err().into());
    assert_eq!(diagnostic.status, 503);
    assert_eq!(diagnostic.error.as_deref(), Some("service_busy"));
    assert_eq!(diagnostic.request_id.as_deref(), Some("native-request"));
    assert_eq!(diagnostic.retry_after, None);
    assert!(diagnostic.understood);
    let diagnostic = native::rest_error(client.logout().await.unwrap_err().into());
    assert_eq!(diagnostic.request_id.as_deref(), Some("logout-request"));
    assert_eq!(diagnostic.retry_after, Some(1));
    let gateway = native::rest_error(client.me().await.unwrap_err().into());
    assert!(!gateway.understood);
    assert_eq!(gateway.request_id, None);
    assert!(!rv_core::rest::is_token_rejected(&gateway));
}

#[tokio::test]
async fn a_positive_incompatible_native_protocol_never_sends_rc_credentials() {
    let server=FakeHttp::start(|_|respond(200,r#"{"product":"rocketvibe","instance_id":"i","data_epoch":"e","server_version":"0.1","protocol_versions":[99],"api_path":"/api/v1","capabilities":{"text_messages":true,"private_rooms":true,"direct_messages":true,"durable_sync":true,"threads":false,"reactions":false,"uploads":false,"push":false,"e2ee":false,"calls":false}}"#)).await;
    assert!(rv_core::session::login(&server.url, "alice", "password", None).await.is_err());
    assert!(!server.requests().is_empty());
    assert!(server.requests().iter().all(|r| r.path() == "/.well-known/rocketvibe"
        && r.method == "GET"
        && !r.headers.contains_key("authorization")));
}
#[test]
fn keychain_sessions_pin_the_native_identity_and_migrate_legacy_accounts() {
    let legacy =
        json!({"baseUrl":"https://example.org","userId":"alice-id","username":"alice","authToken":"test-only"});
    let mut info = SessionInfo::from_secret(&legacy).unwrap();
    assert!(info.native.is_none());
    info.native = Some(Identity { instance_id: "instance".into(), data_epoch: "epoch".into() });
    assert_eq!(SessionInfo::from_secret(&info.secret()).unwrap(), info);
    let mut broken = info.secret();
    broken["nativeDataEpoch"] = json!("");
    assert!(SessionInfo::from_secret(&broken).is_none());
    broken["genre"] = json!("future");
    assert!(SessionInfo::from_secret(&broken).is_none());
    broken["genre"] = json!(17);
    assert!(SessionInfo::from_secret(&broken).is_none());
    assert_ne!(
        native::database_name(&info),
        native::database_name(&SessionInfo { base_url: "https://example.org/other".into(), ..info })
    );
}

#[tokio::test]
async fn prepared_delivery_conflict_keeps_the_desktop_intention_retryable() {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        time::Duration,
    };
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let can_confirm = Arc::new(AtomicBool::new(false));
    let confirmation = can_confirm.clone();
    let responses = fixture.clone();
    let server = FakeHttp::start(move |request| match request.path() {
        "/.well-known/rocketvibe" => respond(200, &responses["discovery"].to_string()),
        "/api/v1/me" => respond(200, &responses["session"]["user"].to_string()),
        "/api/v1/sync/changes" => respond(
            200,
            &json!({"protocol_version":1,"changes":[],"cursor":"opaque-fixture","has_more":false}).to_string(),
        ),
        "/api/v1/rooms/room-id/messages" => {
            if !confirmation.load(Ordering::SeqCst) {
                return respond(409, r#"{"code":"delivery_revalidate","request_id":"prepared-read"}"#);
            }
            let input: serde_json::Value = serde_json::from_str(&request.body).unwrap();
            let mut message = responses["message"].clone();
            message["id"] = input["operation_id"].clone();
            message["text"] = input["text"].clone();
            respond(200, &message.to_string())
        }
        _ => respond(404, r#"{"code":"not_found","request_id":"fake"}"#),
    })
    .await;
    let identity = Identity {
        instance_id: fixture["discovery"]["instance_id"].as_str().unwrap().into(),
        data_epoch: fixture["discovery"]["data_epoch"].as_str().unwrap().into(),
    };
    let path = std::env::temp_dir().join(format!("rv-delivery-{:032x}.sqlite", fastrand::u128(..)));
    let store = native::store::NativeStore::open(&path, identity.clone()).unwrap();
    store
        .snapshot(&rv_protocol::Snapshot {
            protocol_version: 1,
            rooms: vec![serde_json::from_value(fixture["room"].clone()).unwrap()],
            messages: vec![],
            cursor: "opaque-fixture".into(),
        })
        .unwrap();
    store.enqueue("retained-intention", "room-id", "durable retry", "alice").unwrap();
    drop(store);
    let session = native::NativeSession::start(
        SessionInfo {
            base_url: server.url.as_str().into(),
            user_id: "alice-id".into(),
            username: "alice".into(),
            auth_token: "fixture-token".into(),
            native: Some(identity),
        },
        &path,
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.status().error.as_deref() != Some("delivery_revalidate") {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(session.store.pending().unwrap().len(), 1);
    assert_eq!(session.status().request_id.as_deref(), Some("prepared-read"));
    assert_eq!(session.status().retry_after, None);
    can_confirm.store(true, Ordering::SeqCst);
    session.reconnect();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !session.store.pending().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    common::close_native(session).await;
    let requests = server.requests();
    let sends: Vec<_> = requests.iter().filter(|r| r.path() == "/api/v1/rooms/room-id/messages").collect();
    assert!(sends.len() >= 2);
    assert!(
        sends.iter().all(
            |r| serde_json::from_str::<serde_json::Value>(&r.body).unwrap()["operation_id"] == "retained-intention"
        )
    );
    std::fs::remove_file(path).unwrap();
}
