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
