mod common;
use common::{FakeHttp, respond};
use rv_core::native::security::email::Remote as EmailRemote;
use rv_core::{
    native::{
        self, Identity,
        security::{Guard, Remote},
    },
    session::{Connection, SessionInfo},
};
use rv_protocol::parity::{BeginEmailVerification, BeginFactorSetup, RemoveVerifiedEmail};
use serde_json::json;
use std::{
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

#[derive(Default)]
struct Gate {
    started: tokio::sync::Notify,
    open: Mutex<bool>,
    wake: Condvar,
}
impl Gate {
    fn block(&self) {
        self.started.notify_one();
        let mut open = self.open.lock().unwrap();
        while !*open {
            open = self.wake.wait(open).unwrap();
        }
    }
    fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.wake.notify_all();
    }
}
async fn online(session: &native::NativeSession) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.status().connection != Connection::Online {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn access_fences_late_results_reconnections_capabilities_and_context() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let factors = Arc::new(AtomicBool::new(true));
    let wrong_user = Arc::new(AtomicBool::new(false));
    let block = Arc::new(AtomicBool::new(false));
    let gate = Arc::new(Gate::default());
    let factor_reads = Arc::new(AtomicUsize::new(0));
    let mutations = Arc::new(AtomicUsize::new(0));
    let removals = Arc::new(AtomicBool::new(true));
    let email_writes = Arc::new(AtomicUsize::new(0));
    let (contact_enabled, contact_writes) = (removals.clone(), email_writes.clone());
    let epoch_changed = Arc::new(AtomicBool::new(false));
    let epoch = epoch_changed.clone();
    let (data, enabled, wrong, delayed, waiting, reads, writes) = (
        fixture.clone(),
        factors.clone(),
        wrong_user.clone(),
        block.clone(),
        gate.clone(),
        factor_reads.clone(),
        mutations.clone(),
    );
    let server = FakeHttp::start(move |request| match request.path() {
        "/.well-known/rocketvibe" => {
            let mut discovery = data["discovery"].clone();
            discovery["capabilities"]["reauthentication"] = json!(true);
            discovery["capabilities"]["reauthentication_retirement"] = json!(true);
            discovery["capabilities"]["second_factors"] = json!(enabled.load(Ordering::SeqCst));
            discovery["capabilities"]["email_verification"] = json!(false);
            discovery["capabilities"]["email_removal"] = json!(contact_enabled.load(Ordering::SeqCst));
            if epoch.load(Ordering::SeqCst) { discovery["data_epoch"] = json!("changed-epoch"); }
            respond(200, &discovery.to_string())
        }
        "/api/v1/me" => respond(200, &data["session"]["user"].to_string()),
        "/api/v1/sync/changes" => respond(200, &json!({"protocol_version":1,"changes":[],"cursor":"initial","has_more":false}).to_string()),
        "/api/v1/sync/ticket" => respond(200, &data["socket_ticket"].to_string()),
        "/api/v1/sync/socket" => common::Response { websocket:true, ..Default::default() },
        "/api/v1/me/reauth" => respond(200, &json!({
            "user_id":if wrong.load(Ordering::SeqCst) { json!("different") } else { data["session"]["user"]["id"].clone() },
            "device_id":"current", "instance_id":data["discovery"]["instance_id"],
            "data_epoch":data["discovery"]["data_epoch"], "proof_version":"initial", "recent":false
        }).to_string()),
        "/api/v1/me/factors" => {
            reads.fetch_add(1, Ordering::SeqCst);
            if delayed.swap(false, Ordering::SeqCst) { waiting.block(); }
            respond(200, &json!({"totp":false,"email":false,"backup_codes_remaining":0,"factor_version":null}).to_string())
        }
        "/api/v1/me/factors/totp/setup" => {
            writes.fetch_add(1, Ordering::SeqCst);
            respond(403, r#"{"code":"reauthentication_required","request_id":"fixture"}"#)
        }
        "/api/v1/me/email" => respond(200, &json!({
            "address":"owner@example.org", "verified_at":"2026-10-01T12:00:00Z", "version":"contact", "verification_version":"head",
            "context":{"user_id":data["session"]["user"]["id"], "device_id":"current", "instance_id":data["discovery"]["instance_id"], "data_epoch":data["discovery"]["data_epoch"]}
        }).to_string()),
        "/api/v1/me/email/removal/start" | "/api/v1/me/email/verification/start" => {
            contact_writes.fetch_add(1, Ordering::SeqCst);
            respond(400, r#"{"code":"email_removal_rejected","request_id":"fixture"}"#)
        }
        _ => respond(404, r#"{"code":"not_found","request_id":"fixture"}"#),
    }).await;
    let identity = Identity {
        instance_id: fixture["discovery"]["instance_id"].as_str().unwrap().into(),
        data_epoch: fixture["discovery"]["data_epoch"].as_str().unwrap().into(),
    };
    let path = std::env::temp_dir().join(format!("rv-security-access-{:032x}.sqlite", fastrand::u128(..)));
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
            base_url: server.url.as_str().into(),
            user_id: fixture["session"]["user"]["id"].as_str().unwrap().into(),
            username: "alice".into(),
            auth_token: "fixture-token".into(),
            native: Some(identity),
        },
        &path,
    )
    .unwrap();
    online(&session).await;
    let guard = Guard::new();
    let access = session.security(guard.clone()).await.unwrap();
    assert!(session.security_supported() && session.factors_supported());
    block.store(true, Ordering::SeqCst);
    let pending = tokio::spawn({
        let access = access.clone();
        async move { access.factor_status().await }
    });
    gate.started.notified().await;
    guard.cancel();
    gate.release();
    assert_eq!(pending.await.unwrap().unwrap_err().code(), "session_closed");
    assert_eq!(access.factor_status().await.unwrap_err().code(), "session_closed");
    assert_eq!(factor_reads.load(Ordering::SeqCst), 1);

    let stale = session.security(Guard::new()).await.unwrap();
    session.suspend();
    assert_eq!(stale.factor_status().await.unwrap_err().code(), "session_closed");
    session.reconnect();
    online(&session).await;
    assert!(!session.is_closed());
    assert_eq!(stale.factor_status().await.unwrap_err().code(), "session_closed");
    let live = session.security(Guard::new()).await.unwrap();
    factors.store(false, Ordering::SeqCst);
    assert_eq!(
        live.setup(BeginFactorSetup { operation_id: "a".repeat(64) }).await.err().unwrap().code(),
        "unsupported_feature"
    );
    assert_eq!(mutations.load(Ordering::SeqCst), 0);
    assert!(session.security_supported() && !session.factors_supported());
    assert!(session.email_supported() && session.email_removal_supported() && !session.email_verification_supported());
    let contact = EmailRemote::status(&live).await.unwrap();
    assert_eq!(contact.address.as_deref(), Some("owner@example.org"));
    let removal = RemoveVerifiedEmail {
        operation_id: "b".repeat(64),
        expected_version: contact.version,
        verification_version: contact.verification_version,
        context: live.scope().context(),
    };
    assert_eq!(live.remove(removal.clone()).await.err().unwrap().code(), "email_removal_rejected");
    assert_eq!(email_writes.load(Ordering::SeqCst), 1);
    assert_eq!(
        EmailRemote::begin(
            &live,
            BeginEmailVerification {
                verification_id: "c".repeat(64),
                operation_id: "d".repeat(64),
                address: "new@example.org".into(),
                expected_version: "contact".into(),
                verification_version: "head".into(),
                context: live.scope().context()
            }
        )
        .await
        .err()
        .unwrap()
        .code(),
        "unsupported_feature"
    );
    assert_eq!(email_writes.load(Ordering::SeqCst), 1);
    removals.store(false, Ordering::SeqCst);
    assert_eq!(live.remove(removal.clone()).await.err().unwrap().code(), "unsupported_feature");
    assert!(!session.email_supported());
    assert_eq!(email_writes.load(Ordering::SeqCst), 1);
    removals.store(true, Ordering::SeqCst);
    // Identity confirmation still works without a configured factor key.
    assert!(!Remote::status(&live).await.unwrap().recent);
    wrong_user.store(true, Ordering::SeqCst);
    assert_eq!(Remote::status(&live).await.unwrap_err().code(), "server_identity_changed");
    assert_eq!(session.security(Guard::new()).await.err().unwrap().code(), "server_identity_changed");
    // Discovery, rather than an unrelated proof response, is the source's
    // generation barrier before any contact mutation.
    epoch_changed.store(true, Ordering::SeqCst);
    assert_eq!(live.remove(removal.clone()).await.err().unwrap().code(), "server_identity_changed");
    assert_eq!(email_writes.load(Ordering::SeqCst), 1);
    session.shutdown();
    assert!(session.is_closed());
    assert_eq!(live.factor_status().await.unwrap_err().code(), "session_closed");
    assert_eq!(live.remove(removal).await.err().unwrap().code(), "session_closed");
    assert_eq!(email_writes.load(Ordering::SeqCst), 1);
    drop(access);
    drop(stale);
    drop(live);
    common::close_native(session).await;
    std::fs::remove_file(path).unwrap();
}
