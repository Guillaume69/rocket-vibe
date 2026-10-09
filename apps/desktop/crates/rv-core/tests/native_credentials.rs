mod common;
use common::{FakeHttp, respond};
use rv_core::{
    native::{
        self,
        credentials::{self, Record},
    },
    session::SessionInfo,
};
use serde_json::json;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

#[tokio::test]
async fn account_leases_serialize_writers_and_release_cancelled_waiters() {
    use std::time::Duration;
    let info = SessionInfo {
        mattermost: None,
        base_url: "http://localhost:3400".into(),
        user_id: "fixture-user".into(),
        username: "alice".into(),
        auth_token: "fixture-secret".into(),
        native: None,
    };
    let directory = std::env::temp_dir().join(format!("rv-credential-lock-{:032x}", fastrand::u128(..)));
    let first = credentials::lease(&directory, &info).await.unwrap();
    let (path, user) = (directory.clone(), info.clone());
    let waiting = tokio::spawn(async move { credentials::lease(&path, &user).await });
    tokio::time::sleep(Duration::from_millis(75)).await;
    assert!(!waiting.is_finished());
    waiting.abort();
    assert!(waiting.await.unwrap_err().is_cancelled());
    drop(first);
    let second =
        tokio::time::timeout(Duration::from_secs(1), credentials::lease(&directory, &info)).await.unwrap().unwrap();
    drop(second);
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn a_response_for_a_rotated_bearer_cannot_reject_the_current_session() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let updater = Arc::new(Mutex::new(None::<rv_client::NativeClient>));
    let shared = updater.clone();
    let server = FakeHttp::start(move |request| {
        if request.headers.get("authorization") == Some(&format!("Bearer {}", "a".repeat(64))) {
            shared.lock().unwrap().as_ref().unwrap().update_token("c".repeat(64));
            respond(401, r#"{"code":"session_rejected","request_id":"stale-bearer"}"#)
        } else {
            respond(200, &fixture["session"]["user"].to_string())
        }
    })
    .await;
    let mut client = rv_client::NativeClient::new(server.url.as_str()).unwrap();
    client.restore("a".repeat(64));
    *updater.lock().unwrap() = Some(client.clone());
    let error = client.me().await.unwrap_err();
    assert!(
        matches!(error,rv_client::Error::Server{status:409,code,request_id,..} if code=="delivery_revalidate" && request_id.as_deref()==Some("stale-bearer"))
    );
    assert!(client.me().await.is_ok());
    client.restore("a".repeat(64));
    assert!(
        matches!(client.logout().await,Err(rv_client::Error::Server{status:409,code,..}) if code=="delivery_revalidate")
    );
}

#[tokio::test]
async fn a_lost_renewal_ack_recovers_the_durable_successor_without_a_second_rotation() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let stored = Arc::new(Mutex::new(None::<Record>));
    let received = stored.clone();
    let responses = fixture.clone();
    let accepted = Arc::new(AtomicBool::new(false));
    let committed = accepted.clone();
    let renews = Arc::new(AtomicUsize::new(0));
    let sent = renews.clone();
    let server=FakeHttp::start(move |request| match request.path() {
        "/.well-known/rocketvibe"=>{
            let mut discovery=responses["discovery"].clone();discovery["capabilities"]["session_rotation"]=json!(true);
            respond(200,&discovery.to_string())
        },
        "/api/v1/auth/renew"=>{
            let input:serde_json::Value=serde_json::from_str(&request.body).unwrap();
            let secret=received.lock().unwrap().clone().unwrap();
            assert_eq!(input["next_token"],secret.pending.unwrap().next_token);
            sent.fetch_add(1,Ordering::SeqCst);committed.store(true,Ordering::SeqCst);
            respond(503,r#"{"code":"response_lost","request_id":"renew-test"}"#)
        },
        "/api/v1/me" if committed.load(Ordering::SeqCst)=>{
            let token=received.lock().unwrap().as_ref().unwrap().pending.as_ref().unwrap().next_token.clone();
            assert_eq!(request.headers.get("authorization"),Some(&format!("Bearer {token}")));
            respond(200,&responses["session"]["user"].to_string())
        },
        "/api/v1/me/sessions"=>respond(200,&json!([{"id":"device-1","label":"Desktop","created_at":"2026-10-01T00:00:00Z","last_seen_at":"2026-10-01T00:00:00Z","expires_at":"2026-11-01T00:00:00Z","current":true}]).to_string()),
        _=>respond(401,r#"{"code":"session_rejected","request_id":"probe-test"}"#),
    }).await;
    let original = Record {
        info: SessionInfo {
            mattermost: None,
            base_url: server.url.as_str().into(),
            user_id: fixture["session"]["user"]["id"].as_str().unwrap().into(),
            username: "alice".into(),
            auth_token: "a".repeat(64),
            native: Some(native::Identity {
                instance_id: fixture["discovery"]["instance_id"].as_str().unwrap().into(),
                data_epoch: fixture["discovery"]["data_epoch"].as_str().unwrap().into(),
            }),
        },
        pending: None,
        expires_at: None,
    };
    let persist = |record: Record| {
        *stored.lock().unwrap() = Some(record);
        std::future::ready(Ok(()))
    };
    assert!(credentials::renew(original.clone(), persist).await.is_err());
    let durable = stored.lock().unwrap().clone().unwrap();
    assert!(durable.due());
    let pending = durable.pending.clone().unwrap();
    assert_eq!(pending.next_token.len(), 64);
    assert_ne!(pending.next_token, original.info.auth_token);
    let reopened = Record::from_secret(&durable.secret()).unwrap();
    let recovered = credentials::renew(reopened, persist).await.unwrap();
    assert!(accepted.load(Ordering::SeqCst));
    assert_eq!(renews.load(Ordering::SeqCst), 1);
    assert_eq!(recovered.info.auth_token, pending.next_token);
    assert!(recovered.pending.is_none());
    assert_eq!(recovered.expires_at.as_deref(), Some("2026-11-01T00:00:00Z"));
    assert!(stored.lock().unwrap().as_ref().unwrap().pending.is_none());
    assert!(!format!("{:?}", recovered.info).contains(&recovered.info.auth_token));
    let second = credentials::renew(original, |_| {
        std::future::ready(Err(native::Error::Protocol("secure_storage_unavailable")))
    })
    .await;
    assert_eq!(second.err().unwrap().code(), "secure_storage_unavailable");
    assert_eq!(renews.load(Ordering::SeqCst), 1);
}
