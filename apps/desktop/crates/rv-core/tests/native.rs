mod common;
use common::{FakeHttp, respond};
use rv_core::native::{self, Identity};
use rv_core::session::SessionInfo;
use serde_json::json;

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
    can_confirm.store(true, Ordering::SeqCst);
    session.reconnect();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !session.store.pending().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    session.shutdown();
    drop(session);
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
