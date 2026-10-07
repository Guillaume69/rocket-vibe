mod common;
use common::{FakeHttp, respond};
use rv_core::{
    native::{self, Identity},
    session::{Connection, SessionInfo},
};
use serde_json::json;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

#[tokio::test]
async fn device_management_keeps_recent_auth_errors_and_blocks_closed_providers() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let label = Arc::new(Mutex::new("Laptop".to_owned()));
    let mutations = Arc::new(AtomicUsize::new(0));
    let allow = Arc::new(AtomicBool::new(false));
    let corrupt = Arc::new(AtomicBool::new(false));
    let (responses, name, count, recent, broken) =
        (fixture.clone(), label.clone(), mutations.clone(), allow.clone(), corrupt.clone());
    let server=FakeHttp::start(move |request| match request.path() {
        "/.well-known/rocketvibe"=>{
            let mut discovery=responses["discovery"].clone();discovery["capabilities"]["device_sessions"]=json!(true);
            respond(200,&discovery.to_string())
        },
        "/api/v1/me"=>respond(200,&responses["session"]["user"].to_string()),
        "/api/v1/sync/changes"=>respond(200,&json!({"protocol_version":1,"changes":[],"cursor":"initial","has_more":false}).to_string()),
        "/api/v1/sync/ticket"=>respond(200,&responses["socket_ticket"].to_string()),
        "/api/v1/sync/socket"=>common::Response{websocket:true,..Default::default()},
        "/api/v1/me/sessions"=>respond(200,&json!([
            {"id":"current","label":name.lock().unwrap().clone(),"created_at":"2026-10-01T00:00:00Z","last_seen_at":"2026-10-01T00:00:00Z","expires_at":"2026-11-01T00:00:00Z","current":true},
            {"id":"other","label":"Mobile","created_at":"2026-10-01T00:00:00Z","last_seen_at":"2026-10-01T00:00:00Z","expires_at":"2026-11-01T00:00:00Z","current":broken.load(Ordering::SeqCst)}
        ]).to_string()),
        "/api/v1/me/sessions/current" if request.method=="PATCH"=>{
            *name.lock().unwrap()=serde_json::from_str::<serde_json::Value>(&request.body).unwrap()["label"].as_str().unwrap().into();
            count.fetch_add(1,Ordering::SeqCst);respond(204,"")
        },
        "/api/v1/me/sessions/other" if request.method=="DELETE"=>{
            count.fetch_add(1,Ordering::SeqCst);
            if recent.load(Ordering::SeqCst) {respond(204,"")} else {respond(403,r#"{"code":"reauthentication_required","request_id":"reauth-device"}"#)}
        },
        _=>respond(404,r#"{"code":"not_found","request_id":"fixture"}"#),
    }).await;
    let identity = Identity {
        instance_id: fixture["discovery"]["instance_id"].as_str().unwrap().into(),
        data_epoch: fixture["discovery"]["data_epoch"].as_str().unwrap().into(),
    };
    let path = std::env::temp_dir().join(format!("rv-devices-{:032x}.sqlite", fastrand::u128(..)));
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
        mattermost: None,
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
    assert!(session.supported_features().iter().any(|f| f == "device_sessions"));
    assert_eq!(session.device_sessions().await.unwrap().len(), 2);
    session.rename_device("current", "Desktop renamed").await.unwrap();
    assert_eq!(session.device_sessions().await.unwrap()[0].label, "Desktop renamed");
    assert_eq!(session.revoke_device("current").await.unwrap_err().code(), "current_device_requires_logout");
    let error = session.revoke_device("other").await.unwrap_err();
    assert_eq!(error.code(), "reauthentication_required");
    assert!(
        matches!(error,native::Error::Network(rv_client::Error::Server{status:403,request_id,..}) if request_id.as_deref()==Some("reauth-device"))
    );
    allow.store(true, Ordering::SeqCst);
    session.revoke_device("other").await.unwrap();
    corrupt.store(true, Ordering::SeqCst);
    assert_eq!(session.device_sessions().await.unwrap_err().code(), "invalid_native_session");
    session.shutdown();
    assert_eq!(session.rename_device("current", "Stale callback").await.unwrap_err().code(), "session_closed");
    assert_eq!(session.revoke_device("other").await.unwrap_err().code(), "session_closed");
    assert_eq!(mutations.load(Ordering::SeqCst), 3);
    common::close_native(session).await;
    std::fs::remove_file(path).unwrap();
}
