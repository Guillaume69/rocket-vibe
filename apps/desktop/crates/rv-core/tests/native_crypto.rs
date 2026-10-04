mod common;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use common::{FakeHttp, respond};
use rv_core::{
    native::{self, crypto, security::Guard},
    session::{Connection, SessionInfo},
};
use rv_crypto::{
    identity::{Issuer, Root, enrollment::LocalDevice},
    packages,
    protected::{Manager, Storage},
    vault::{self, Scope},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

#[derive(Default)]
struct Memory {
    values: Mutex<BTreeMap<String, Zeroizing<Vec<u8>>>>,
    reads: AtomicUsize,
    writes: AtomicUsize,
    blocked_write: Mutex<Option<Arc<Gate>>>,
}
impl Storage for Memory {
    fn read(&self, name: &str) -> std::result::Result<Option<Zeroizing<Vec<u8>>>, vault::Error> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Ok(self.values.lock().unwrap().get(name).map(|value| Zeroizing::new(value.to_vec())))
    }
    fn write(&self, name: &str, value: &[u8]) -> std::result::Result<(), vault::Error> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        let gate = self.blocked_write.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.block();
        }
        self.values.lock().unwrap().insert(name.into(), Zeroizing::new(value.to_vec()));
        Ok(())
    }
}
#[derive(Default)]
struct Gate {
    entered: tokio::sync::Notify,
    open: Mutex<bool>,
    wake: Condvar,
}
impl Gate {
    fn block(&self) {
        self.entered.notify_one();
        let mut open = self.open.lock().unwrap();
        while !*open {
            open = self.wake.wait(open).unwrap();
        }
    }
    fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.wake.notify_all();
    }
    async fn entered(&self) {
        let result = tokio::time::timeout(Duration::from_secs(5), self.entered.notified()).await;
        if result.is_err() {
            self.release();
        }
        result.expect("crypto request did not reach its gate");
    }
}
struct Pilot {
    directory: tempfile::TempDir,
    server: FakeHttp,
    session: Arc<native::NativeSession>,
    memory: Arc<Memory>,
    manager: Arc<Manager>,
    root: Root,
    enabled: Arc<AtomicBool>,
    duplicate_device: Arc<AtomicBool>,
    changed_epoch: Arc<AtomicBool>,
    block: Arc<AtomicUsize>,
    gate: Arc<Gate>,
    publications: Arc<Mutex<Vec<String>>>,
    crypto_directory: Arc<Mutex<Value>>,
    peer_directories: Arc<Mutex<BTreeMap<String, Value>>>,
    registrations: Arc<Mutex<Vec<String>>>,
    registration_receipt: Arc<Mutex<Option<Value>>>,
    lose_registration: Arc<AtomicBool>,
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
impl Pilot {
    async fn new(enabled: bool) -> Self {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
        let enabled = Arc::new(AtomicBool::new(enabled));
        let duplicate_device = Arc::new(AtomicBool::new(false));
        let changed_epoch = Arc::new(AtomicBool::new(false));
        let block = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Gate::default());
        let publications = Arc::new(Mutex::new(vec![]));
        let crypto_directory = Arc::new(Mutex::new(
            json!({"scope": {"instance_id": fixture["discovery"]["instance_id"], "data_epoch": fixture["discovery"]["data_epoch"]}, "identity": null, "devices": [], "revocations": [], "next_revocation": null}),
        ));
        let registrations = Arc::new(Mutex::new(vec![]));
        let peer_directories = Arc::new(Mutex::new(BTreeMap::<String, Value>::new()));
        let peer_reply = peer_directories.clone();
        let registration_receipt = Arc::new(Mutex::new(None::<Value>));
        let lose_registration = Arc::new(AtomicBool::new(false));
        let (directory_reply, enrollments, receipt_reply, lose_reply) =
            (crypto_directory.clone(), registrations.clone(), registration_receipt.clone(), lose_registration.clone());
        let (data, capable, duplicate, changed, delayed, waiting, posted) = (
            fixture.clone(),
            enabled.clone(),
            duplicate_device.clone(),
            changed_epoch.clone(),
            block.clone(),
            gate.clone(),
            publications.clone(),
        );
        let server = FakeHttp::start(move |request| match request.path() {
            path if path.starts_with("/api/v1/e2ee/users/") => {
                let key = request.target.strip_prefix("/api/v1/e2ee/users/").unwrap();
                if let Some(page) = peer_reply.lock().unwrap().get(key) { respond(200, &page.to_string()) }
                else if path.rsplit('/').next() == data["session"]["user"]["id"].as_str() { respond(200, &directory_reply.lock().unwrap().to_string()) }
                else { respond(404, r#"{"code":"not_found","request_id":"crypto-pilot"}"#) }
            }
            path if path.starts_with("/api/v1/e2ee/operations/") => {
                if let Some(receipt) = receipt_reply.lock().unwrap().as_ref() { respond(200, &receipt.to_string()) }
                else { respond(404, r#"{"code":"not_found","request_id":"crypto-pilot"}"#) }
            }
            "/api/v1/e2ee/devices" => {
                assert_eq!(request.headers["authorization"], "Bearer fixture-token");
                enrollments.lock().unwrap().push(request.body.clone());
                let input: rv_protocol::e2ee::RegisterDevice = serde_json::from_str(&request.body).unwrap();
                let grant = rv_crypto::identity::enrollment::Grant::from_bytes(&B64.decode(&input.grant).unwrap()).unwrap();
                let signed = rv_crypto::identity::enrollment::Request::from_bytes(&B64.decode(&input.request).unwrap()).unwrap();
                let time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
                grant.verify(time).unwrap(); signed.verify(time).unwrap();
                assert_eq!(grant.request, signed.fingerprint().unwrap());
                let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
                let certificate = &grant.certificate.device;
                let receipt = json!({"scope": input.scope, "operation_id":input.operation_id, "kind":"register_device", "device_id":certificate.device,
                    "incarnation":hex(&certificate.incarnation), "device_revision":"1", "root_fingerprint":hex(&certificate.root.fingerprint().unwrap()), "key_package_refs":[]});
                *receipt_reply.lock().unwrap() = Some(receipt.clone());
                let mut directory = directory_reply.lock().unwrap();
                directory["identity"] = json!({"user_id": certificate.root.user, "root": B64.encode(serde_json::to_vec(&certificate.root).unwrap()), "fingerprint":receipt["root_fingerprint"], "revision":"1"});
                directory["devices"] = json!([{"device_id":certificate.device, "incarnation":receipt["incarnation"], "certificate":B64.encode(serde_json::to_vec(&grant.certificate).unwrap()), "revision":"1", "expires_at":certificate.expires_at.to_string()}]);
                if lose_reply.load(Ordering::SeqCst) { respond(503, r#"{"code":"response_lost","request_id":"crypto-pilot"}"#) }
                else { respond(200, &receipt.to_string()) }
            }
            "/.well-known/rocketvibe" => {
                let mut discovery = data["discovery"].clone();
                discovery["capabilities"]["e2ee"] = json!(capable.load(Ordering::SeqCst));
                if changed.load(Ordering::SeqCst) { discovery["data_epoch"] = json!("replacement-epoch"); }
                respond(200, &discovery.to_string())
            }
            "/api/v1/me" => respond(200, &data["session"]["user"].to_string()),
            "/api/v1/me/sessions" => {
                if delayed.compare_exchange(1, 0, Ordering::SeqCst, Ordering::SeqCst).is_ok() { waiting.block(); }
                respond(200, &json!([
                    {"id":"current", "label":"Desktop", "created_at":"0", "last_seen_at":"0", "expires_at":"0", "current":true},
                    {"id":"other", "label":"Other", "created_at":"0", "last_seen_at":"0", "expires_at":"0", "current":duplicate.load(Ordering::SeqCst)}
                ]).to_string())
            }
            "/api/v1/sync/changes" => respond(200, &json!({"protocol_version":1,"changes":[],"cursor":"initial","has_more":false}).to_string()),
            "/api/v1/sync/ticket" => respond(200, &data["socket_ticket"].to_string()),
            "/api/v1/sync/socket" => common::Response { websocket:true, ..Default::default() },
            "/api/v1/e2ee/key-packages" => {
                assert_eq!(request.headers["authorization"], "Bearer fixture-token");
                posted.lock().unwrap().push(request.body.clone());
                if delayed.compare_exchange(2, 0, Ordering::SeqCst, Ordering::SeqCst).is_ok() { waiting.block(); }
                respond(503, r#"{"code":"response_lost","request_id":"crypto-pilot"}"#)
            }
            _ => respond(404, r#"{"code":"not_found","request_id":"crypto-pilot"}"#),
        }).await;
        let identity = native::Identity {
            instance_id: fixture["discovery"]["instance_id"].as_str().unwrap().into(),
            data_epoch: fixture["discovery"]["data_epoch"].as_str().unwrap().into(),
        };
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("ordinary.sqlite");
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
        let user = fixture["session"]["user"]["id"].as_str().unwrap();
        let memory = Arc::new(Memory::default());
        let manager = Arc::new(
            Manager::new(
                directory.path().join("private"),
                Scope {
                    instance: identity.instance_id.clone(),
                    data_epoch: identity.data_epoch.clone(),
                    user: user.into(),
                    device: "current".into(),
                    incarnation: "01".repeat(16),
                },
                memory.clone(),
            )
            .unwrap(),
        );
        let root = Issuer::generate(&identity.instance_id, user).unwrap().root().clone();
        let session = native::NativeSession::start(
            SessionInfo {
                base_url: server.url.as_str().into(),
                user_id: user.into(),
                username: "alice".into(),
                auth_token: "fixture-token".into(),
                native: Some(identity),
            },
            &path,
        )
        .unwrap();
        online(&session).await;
        Self {
            directory,
            server,
            session,
            memory,
            manager,
            root,
            enabled,
            duplicate_device,
            changed_epoch,
            block,
            gate,
            publications,
            crypto_directory,
            peer_directories,
            registrations,
            registration_receipt,
            lose_registration,
        }
    }
    async fn attach(&self, guard: Guard) -> crypto::Access {
        self.session.crypto(guard, self.manager.clone(), self.root.clone()).await.unwrap()
    }
    fn initialize(&mut self) {
        self.manager.initialize().unwrap();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let issuer = Issuer::generate(&self.manager.scope().instance, &self.manager.scope().user).unwrap();
        self.root = issuer.root().clone();
        self.manager
            .transact(|_, records| {
                issuer.save(records).unwrap();
                let mut local = LocalDevice::create_bound(&self.root, "current", [1; 16], records).unwrap();
                let request = local.request(now, records).unwrap();
                let consent = issuer.preview_request(&request, now, 3600, records).unwrap();
                let grant = issuer.approve_request(&request, &consent, now, records).unwrap();
                local.install(&grant, now, records).unwrap();
                Ok(())
            })
            .unwrap();
    }
    async fn close(self) {
        self.gate.release();
        common::close_native(self.session).await;
    }
}
fn session_code(error: crypto::Error) -> String {
    match error {
        crypto::Error::Session(error) => error.code().into(),
        other => panic!("unexpected crypto error: {other}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disabled_capability_and_substituted_scopes_never_open_the_private_vault() {
    let pilot = Pilot::new(false).await;
    let rejected = pilot.session.crypto(Guard::new(), pilot.manager.clone(), pilot.root.clone()).await;
    assert_eq!(session_code(rejected.err().unwrap()), "unsupported_feature");
    pilot.enabled.store(true, Ordering::SeqCst);
    for field in 0..4 {
        let mut scope = pilot.manager.scope().clone();
        match field {
            0 => scope.instance = "other-instance".into(),
            1 => scope.data_epoch = "other-epoch".into(),
            2 => scope.user = "other-user".into(),
            _ => scope.device = "other-device".into(),
        }
        let manager =
            Arc::new(Manager::new(pilot.directory.path().join("private"), scope, pilot.memory.clone()).unwrap());
        let result = pilot.session.crypto(Guard::new(), manager, pilot.root.clone()).await;
        assert_eq!(session_code(result.err().unwrap()), "crypto_delivery_scope_changed");
    }
    pilot.duplicate_device.store(true, Ordering::SeqCst);
    let rejected = pilot.session.crypto(Guard::new(), pilot.manager.clone(), pilot.root.clone()).await;
    assert_eq!(session_code(rejected.err().unwrap()), "crypto_delivery_scope_changed");
    assert!(!pilot.session.supported_features().iter().any(|feature| feature == "e2ee"));
    assert_eq!(pilot.memory.reads.load(Ordering::SeqCst), 0);
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), 0);
    assert!(!pilot.directory.path().join("private").exists());
    assert!(pilot.publications.lock().unwrap().is_empty());
    pilot.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn viewer_closure_during_http_prevents_private_work_and_old_access_never_revives() {
    let pilot = Pilot::new(true).await;
    let guard = Guard::new();
    let access = pilot.attach(guard.clone()).await;
    pilot.block.store(1, Ordering::SeqCst);
    let pending = tokio::spawn({
        let access = access.clone();
        async move { access.publish_packages("1".into(), 1).await }
    });
    pilot.gate.entered().await;
    guard.cancel();
    pilot.gate.release();
    assert_eq!(session_code(pending.await.unwrap().err().unwrap()), "session_closed");
    assert_eq!(pilot.memory.reads.load(Ordering::SeqCst), 0);
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), 0);
    assert!(pilot.publications.lock().unwrap().is_empty());
    let current = pilot.attach(Guard::new()).await;
    assert_eq!(session_code(access.resume_packages().await.err().unwrap()), "session_closed");
    let duplicate = pilot.session.crypto(Guard::new(), pilot.manager.clone(), pilot.root.clone()).await;
    assert_eq!(session_code(duplicate.err().unwrap()), "crypto_session_already_open");
    pilot.session.suspend();
    assert_eq!(session_code(current.check().err().unwrap()), "session_closed");
    pilot.session.reconnect();
    online(&pilot.session).await;
    assert_eq!(session_code(current.resume_packages().await.err().unwrap()), "session_closed");
    let fresh = pilot.attach(Guard::new()).await;
    pilot.session.shutdown();
    assert_eq!(session_code(fresh.check().err().unwrap()), "session_closed");
    // Access holds only a weak session. Closing succeeds with every clone alive.
    pilot.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn prepared_mls_packages_survive_closed_viewer_and_reopen_as_the_exact_original_http_body() {
    let mut pilot = Pilot::new(true).await;
    pilot.initialize();
    let guard = Guard::new();
    let access = pilot.attach(guard.clone()).await;
    pilot.block.store(2, Ordering::SeqCst);
    let pending = tokio::spawn({
        let access = access.clone();
        async move { access.publish_packages("1".into(), 1).await }
    });
    pilot.gate.entered().await;
    guard.cancel();
    pilot.gate.release();
    assert_eq!(session_code(pending.await.unwrap().err().unwrap()), "session_closed");
    let original = pilot.publications.lock().unwrap()[0].clone();
    let coordinator = packages::Coordinator::new(pilot.manager.clone(), pilot.root.clone()).unwrap();
    assert!(coordinator.pending_lookup().is_ok());
    let reopened = Arc::new(
        Manager::new(pilot.directory.path().join("private"), pilot.manager.scope().clone(), pilot.memory.clone())
            .unwrap(),
    );
    let fresh = pilot.session.crypto(Guard::new(), reopened, pilot.root.clone()).await.unwrap();
    assert!(matches!(
        fresh.resume_packages().await,
        Err(crypto::Error::Delivery(rv_crypto::delivery::Error::Network(_)))
    ));
    let posted = pilot.publications.lock().unwrap().clone();
    assert_eq!(posted.len(), 2);
    assert_eq!(posted[1], original);
    let body: rv_protocol::e2ee::PublishKeyPackages = serde_json::from_str(&original).unwrap();
    assert_eq!(body.packages.len(), 1);
    assert_eq!(body.scope.instance_id, fresh.scope().instance);
    assert_eq!(body.scope.data_epoch, fresh.scope().data_epoch);
    let writes = pilot.memory.writes.load(Ordering::SeqCst);
    assert_eq!(session_code(access.resume_packages().await.err().unwrap()), "session_closed");
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), writes);
    assert_eq!(pilot.publications.lock().unwrap().len(), 2);
    pilot.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelled_app_task_keeps_its_owned_checkpoint_lease_and_never_posts_after_closure() {
    let mut pilot = Pilot::new(true).await;
    pilot.initialize();
    let access = pilot.attach(Guard::new()).await;
    let gate = Arc::new(Gate::default());
    *pilot.memory.blocked_write.lock().unwrap() = Some(gate.clone());
    let pending = tokio::spawn({
        let access = access.clone();
        async move { access.publish_packages("1".into(), 1).await }
    });
    gate.entered().await;
    access.stop();
    pending.abort();
    let cancelled = pending.await.err().is_some_and(|error| error.is_cancelled());
    let busy = pilot.manager.inspect(|_, _| Ok(()));
    let no_post = pilot.publications.lock().unwrap().is_empty();
    gate.release();
    assert!(cancelled);
    assert_eq!(busy.unwrap_err(), vault::Error::Busy);
    assert!(no_post);
    let coordinator = packages::Coordinator::new(pilot.manager.clone(), pilot.root.clone()).unwrap();
    let lookup = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match coordinator.pending_lookup() {
                Ok(pending) => break pending,
                Err(packages::Error::Storage(vault::Error::Busy)) => {
                    tokio::time::sleep(Duration::from_millis(10)).await
                }
                error => {
                    panic!("checkpoint did not finish as the original package intention: {}", error.err().unwrap())
                }
            }
        }
    })
    .await
    .unwrap();
    assert!(pilot.publications.lock().unwrap().is_empty());
    let fresh = pilot.attach(Guard::new()).await;
    assert!(matches!(
        fresh.resume_packages().await,
        Err(crypto::Error::Delivery(rv_crypto::delivery::Error::Network(_)))
    ));
    let posted = pilot.publications.lock().unwrap().clone();
    assert_eq!(posted.len(), 1);
    let body: rv_protocol::e2ee::PublishKeyPackages = serde_json::from_str(&posted[0]).unwrap();
    assert_eq!(body.operation_id, lookup.operation_id);
    assert_eq!(body.packages.len(), 1);
    assert_eq!(session_code(access.resume_packages().await.err().unwrap()), "session_closed");
    pilot.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fresh_discovery_disables_crypto_and_changed_server_generation_fences_existing_access() {
    for capability in [false, true] {
        let pilot = Pilot::new(true).await;
        let access = pilot.attach(Guard::new()).await;
        if capability {
            pilot.enabled.store(false, Ordering::SeqCst);
        } else {
            pilot.changed_epoch.store(true, Ordering::SeqCst);
        }
        let error = access.publish_packages("1".into(), 1).await.err().unwrap();
        if capability {
            assert_eq!(session_code(error), "unsupported_feature");
        } else {
            assert!(matches!(error, crypto::Error::Delivery(rv_crypto::delivery::Error::Scope)));
        }
        assert_eq!(session_code(access.resume_packages().await.err().unwrap()), "session_closed");
        assert_eq!(pilot.memory.reads.load(Ordering::SeqCst), 0);
        assert!(pilot.publications.lock().unwrap().is_empty());
        assert!(pilot.server.requests().iter().all(|request| !request.path().starts_with("/api/v1/e2ee/")));
        pilot.close().await;
    }
}

#[tokio::test]
async fn identity_ceremony_registers_real_grants_and_recovers_a_lost_reply_after_reopen() {
    use crypto::enrollment::Stage;
    let pilot = Pilot::new(true).await;
    let path = pilot.directory.path().join("ceremony");
    let guard = Guard::new();
    let access = pilot.session.crypto_settings(guard.clone(), path.clone(), pilot.memory.clone()).await.unwrap();
    let empty = access.refresh().await.unwrap();
    assert!(empty.stage == Stage::Missing);
    assert!(access.conversation().await.is_err());
    assert!(pilot.memory.values.lock().unwrap().is_empty());
    let created = access.begin(String::new()).await.unwrap();
    assert!(created.stage == Stage::IdentityCreated && created.controls_root);
    assert_eq!(pilot.registrations.lock().unwrap().len(), 0);
    let fingerprint = created.root_fingerprint.clone();
    let code = created.request_code.clone();
    let reopened = access.begin(String::new()).await.unwrap();
    assert_eq!(reopened.request_code, code);
    let preview = access.preview(code).await.unwrap();
    assert_eq!(preview.root_fingerprint, fingerprint);
    let grant = access.approve(preview).await.unwrap();
    assert_eq!(pilot.registrations.lock().unwrap().len(), 0);
    pilot.lose_registration.store(true, Ordering::SeqCst);
    assert!(access.install(grant).await.is_err());
    assert!(access.refresh().await.unwrap().stage == Stage::Registering);
    guard.cancel();
    access.close();
    let resumed = pilot.session.crypto_settings(Guard::new(), path, pilot.memory.clone()).await.unwrap();
    let ready = resumed.resume().await.unwrap();
    assert!(ready.stage == Stage::Ready);
    assert_eq!(ready.root_fingerprint, fingerprint);
    assert_eq!(pilot.registrations.lock().unwrap().len(), 1);
    assert!(pilot.registration_receipt.lock().unwrap().is_some());
    assert!(!pilot.session.supported_features().iter().any(|f| f == "e2ee"));
    let conversation = resumed.conversation().await.unwrap();
    let writes = pilot.memory.writes.load(Ordering::SeqCst);
    let empty = conversation.local_group_status("room").await.unwrap();
    assert!(empty.accepted.is_none() && empty.pending.is_none());
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), writes);
    let remote = pilot.crypto_directory.lock().unwrap().clone();
    assert_eq!(conversation.scope().incarnation, remote["devices"][0]["incarnation"]);
    assert_eq!(pilot.registrations.lock().unwrap().len(), 1);
    resumed.close();
    assert!(conversation.check().is_err());
    assert!(conversation.local_group_status("room").await.is_err());
    pilot.close().await;
}

#[tokio::test]
async fn a_new_device_requires_the_observed_root_and_an_explicit_external_approval() {
    use crypto::enrollment::Stage;
    let mut pilot = Pilot::new(true).await;
    pilot.initialize();
    let fingerprint = pilot.root.fingerprint().unwrap().iter().map(|b| format!("{b:02x}")).collect::<String>();
    pilot.crypto_directory.lock().unwrap()["identity"] = json!({"user_id":pilot.session.info.user_id,"root":B64.encode(serde_json::to_vec(&pilot.root).unwrap()), "fingerprint":fingerprint, "revision":"1"});
    let access = pilot
        .session
        .crypto_settings(Guard::new(), pilot.directory.path().join("new-device"), pilot.memory.clone())
        .await
        .unwrap();
    let before = pilot.memory.writes.load(Ordering::SeqCst);
    assert!(access.begin("uncompared-root".into()).await.is_err());
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), before);
    let pending = access.begin(fingerprint.clone()).await.unwrap();
    assert!(pending.stage == Stage::WaitingForApproval && !pending.controls_root);
    assert_eq!(pending.root_fingerprint, fingerprint);
    assert!(access.preview(pending.request_code.clone()).await.is_err());
    let request =
        rv_crypto::identity::enrollment::Request::from_bytes(&B64.decode(pending.request_code).unwrap()).unwrap();
    let time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let grant = pilot
        .manager
        .transact(|_, records| {
            let issuer = Issuer::load(records, &pilot.root.instance, &pilot.root.user).unwrap();
            let preview = issuer.preview_request(&request, time, 86400, records).unwrap();
            Ok(issuer.approve_request(&request, &preview, time, records).unwrap())
        })
        .unwrap();
    let ready = access.install(B64.encode(grant.to_bytes().unwrap())).await.unwrap();
    assert!(ready.stage == Stage::Ready && !ready.controls_root);
    assert_eq!(ready.root_fingerprint, fingerprint);
    pilot.close().await;
}

#[tokio::test]
async fn stale_view_consent_and_disabled_capabilities_cannot_initialize_or_approve() {
    let pilot = Pilot::new(true).await;
    let path = pilot.directory.path().join("ceremony");
    let guard = Guard::new();
    let access = pilot.session.crypto_settings(guard.clone(), path.clone(), pilot.memory.clone()).await.unwrap();
    let pending = access.begin(String::new()).await.unwrap();
    let preview = access.preview(pending.request_code).await.unwrap();
    guard.cancel();
    let before = pilot.memory.writes.load(Ordering::SeqCst);
    assert!(access.approve(preview).await.is_err());
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), before);
    let fresh = pilot.session.crypto_settings(Guard::new(), path, pilot.memory.clone()).await.unwrap();
    pilot.enabled.store(false, Ordering::SeqCst);
    assert!(fresh.begin(String::new()).await.is_err());
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), before);
    pilot.enabled.store(true, Ordering::SeqCst);
    assert!(fresh.refresh().await.is_err());
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), before);
    pilot.close().await;
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
struct Peer {
    issuer: Issuer,
    certificate: rv_crypto::identity::Certificate,
    directory: Value,
}
impl Peer {
    fn new(user: &str) -> Self {
        let issuer = Issuer::generate("fixture-instance", user).unwrap();
        let mut records = vault::Records::new();
        let time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let mut local = LocalDevice::create_bound(issuer.root(), "peer-device", [17; 16], &mut records).unwrap();
        let request = local.request(time, &mut records).unwrap();
        let preview = issuer.preview_request(&request, time, 3600, &records).unwrap();
        let grant = issuer.approve_request(&request, &preview, time, &mut records).unwrap();
        local.install(&grant, time, &mut records).unwrap();
        let certificate = grant.certificate;
        let directory = json!({
            "scope": {"instance_id":"fixture-instance", "data_epoch":"fixture-epoch"},
            "identity": {"user_id":user, "root": B64.encode(serde_json::to_vec(issuer.root()).unwrap()),
                "fingerprint":hex(&issuer.root().fingerprint().unwrap()), "revision":"1"},
            "devices": [{"device_id":"peer-device", "incarnation":hex(&certificate.device.incarnation),
                "certificate":B64.encode(serde_json::to_vec(&certificate).unwrap()), "revision":"1",
                "expires_at":certificate.device.expires_at.to_string()}],
            "revocations": [], "next_revocation":null
        });
        Self { issuer, certificate, directory }
    }
    fn revoke(&self, device: &str, incarnation: [u8; 16], position: u64) -> Value {
        let signed = self.issuer.revoke(device, incarnation).unwrap();
        json!({"position":position.to_string(), "signed":B64.encode(serde_json::to_vec(&signed).unwrap())})
    }
}
async fn ready(pilot: &Pilot) -> crypto::enrollment::Access {
    let access = pilot
        .session
        .crypto_settings(Guard::new(), pilot.directory.path().join("ceremony"), pilot.memory.clone())
        .await
        .unwrap();
    let created = access.begin(String::new()).await.unwrap();
    let preview = access.preview(created.request_code).await.unwrap();
    let grant = access.approve(preview).await.unwrap();
    assert!(access.install(grant).await.unwrap().stage == crypto::enrollment::Stage::Ready);
    access
}
async fn approve_peer(access: &crypto::enrollment::Access, user: &str) -> crypto::enrollment::peers::View {
    use crypto::enrollment::peers::RootChoice;
    let peer = access.peer(user.into()).await.unwrap();
    let fingerprint = peer.fingerprint.clone();
    let pinned = access.pin_peer(peer, RootChoice::FirstContact, fingerprint.clone(), String::new()).await.unwrap();
    let verified = access.pin_peer(pinned, RootChoice::Verify, fingerprint, String::new()).await.unwrap();
    let preview = access.preview_peer_device(verified, "peer-device".into()).await.unwrap();
    access.approve_peer_device(preview).await.unwrap()
}

#[tokio::test]
async fn profile_review_separates_first_contact_verified_root_and_explicit_device_approval() {
    use crypto::enrollment::peers::{RootChoice, Trust};
    let pilot = Pilot::new(true).await;
    let access = ready(&pilot).await;
    let peer = Peer::new("bob-id");
    pilot.peer_directories.lock().unwrap().insert("bob-id".into(), peer.directory);
    let before = pilot.memory.writes.load(Ordering::SeqCst);
    let unknown = access.peer("bob-id".into()).await.unwrap();
    assert!(unknown.trust == Trust::Unknown && !unknown.devices[0].approved);
    assert!(access.preview_peer_device(unknown, "peer-device".into()).await.is_err());
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), before);
    let unknown = access.peer("bob-id".into()).await.unwrap();
    assert!(access.pin_peer(unknown, RootChoice::FirstContact, "00".repeat(32), String::new()).await.is_err());
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), before);
    let unknown = access.peer("bob-id".into()).await.unwrap();
    let fingerprint = unknown.fingerprint.clone();
    let pinned = access.pin_peer(unknown, RootChoice::FirstContact, fingerprint.clone(), String::new()).await.unwrap();
    assert!(pinned.trust == Trust::Unverified && !pinned.devices[0].approved);
    let verified = access.pin_peer(pinned, RootChoice::Verify, fingerprint, String::new()).await.unwrap();
    assert!(verified.trust == Trust::Verified && !verified.devices[0].approved);
    let before = pilot.memory.writes.load(Ordering::SeqCst);
    let consent = access.preview_peer_device(verified, "peer-device".into()).await.unwrap();
    assert_eq!(consent.fingerprint, hex(&peer.certificate.fingerprint().unwrap()));
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), before);
    let approved = access.approve_peer_device(consent).await.unwrap();
    assert!(approved.trust == Trust::Verified && approved.devices[0].approved);
    let before = pilot.memory.writes.load(Ordering::SeqCst);
    assert!(access.peer("bob-id".into()).await.unwrap().devices[0].approved);
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), before);
    assert_eq!(pilot.registrations.lock().unwrap().len(), 1);
    assert!(pilot.publications.lock().unwrap().is_empty());
    let foreign = pilot
        .session
        .crypto_settings(Guard::new(), pilot.directory.path().join("ceremony"), pilot.memory.clone())
        .await
        .unwrap();
    assert!(foreign.preview_peer_device(approved, "peer-device".into()).await.is_err());
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), before);
    access.close();
    assert!(access.peer("bob-id".into()).await.is_err());
    pilot.close().await;
}

#[tokio::test]
async fn changed_roots_stale_consents_and_signed_paginated_withdrawals_block_peer_devices() {
    use crypto::enrollment::peers::{RootChoice, Trust};
    let pilot = Pilot::new(true).await;
    let access = ready(&pilot).await;
    let original = Peer::new("bob-id");
    pilot.peer_directories.lock().unwrap().insert("bob-id".into(), original.directory);
    let approved = approve_peer(&access, "bob-id").await;
    let previous = approved.fingerprint.clone();
    let stale = access.preview_peer_device(approved, "peer-device".into()).await.unwrap();
    let replacement = Peer::new("bob-id");
    pilot.peer_directories.lock().unwrap().insert("bob-id".into(), replacement.directory.clone());
    let before = pilot.memory.writes.load(Ordering::SeqCst);
    assert!(access.approve_peer_device(stale).await.is_err());
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), before);
    let changed = access.peer("bob-id".into()).await.unwrap();
    assert!(changed.trust == Trust::Changed && !changed.devices[0].approved);
    assert_eq!(changed.previous_fingerprint, previous);
    let fingerprint = changed.fingerprint.clone();
    assert!(access.pin_peer(changed, RootChoice::Verify, fingerprint.clone(), String::new()).await.is_err());
    let changed = access.peer("bob-id".into()).await.unwrap();
    let replaced = access.pin_peer(changed, RootChoice::Replace, fingerprint, previous).await.unwrap();
    assert!(replaced.trust == Trust::Verified && !replaced.devices[0].approved);
    let consent = access.preview_peer_device(replaced, "peer-device".into()).await.unwrap();
    assert!(access.approve_peer_device(consent).await.unwrap().devices[0].approved);
    let mut first = replacement.directory.clone();
    first["revocations"] = json!([replacement.revoke("another-device", [18; 16], 1)]);
    first["next_revocation"] = json!("1");
    let mut second = replacement.directory.clone();
    second["revocations"] = json!([replacement.revoke("peer-device", replacement.certificate.device.incarnation, 2)]);
    pilot.peer_directories.lock().unwrap().extend([("bob-id".into(), first), ("bob-id?after=1".into(), second)]);
    let withdrawn = access.peer("bob-id".into()).await.unwrap();
    assert!(!withdrawn.devices[0].approved);
    assert!(access.preview_peer_device(withdrawn, "peer-device".into()).await.is_err());
    let before = pilot.memory.writes.load(Ordering::SeqCst);
    assert!(!access.peer("bob-id".into()).await.unwrap().devices[0].approved);
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), before);
    // A later omission cannot revive a withdrawal already authenticated locally.
    pilot.peer_directories.lock().unwrap().insert("bob-id".into(), replacement.directory);
    let withdrawn = access.peer("bob-id".into()).await.unwrap();
    assert!(access.preview_peer_device(withdrawn, "peer-device".into()).await.is_err());
    pilot.close().await;
}

#[tokio::test]
async fn a_signed_own_device_withdrawal_survives_directory_omission_and_reopening() {
    use rv_crypto::installation::{Account, Installation};
    let pilot = Pilot::new(true).await;
    let access = ready(&pilot).await;
    let conversation = access.conversation().await.unwrap();
    let identity = pilot.session.info.native.as_ref().unwrap();
    let path = pilot.directory.path().join("ceremony");
    let manager = Installation::new(
        path.clone(),
        Account {
            origin: pilot.session.info.base_url.clone(),
            instance: identity.instance_id.clone(),
            data_epoch: identity.data_epoch.clone(),
            user: pilot.session.info.user_id.clone(),
            device: "current".into(),
        },
        pilot.memory.clone(),
    )
    .unwrap()
    .load()
    .unwrap()
    .unwrap();
    let signed = manager
        .inspect(|_, records| {
            let issuer = Issuer::load(records, &manager.scope().instance, &manager.scope().user).unwrap();
            let incarnation = rv_crypto::identity::Certificate::from_credential(
                &LocalDevice::load(issuer.root(), "current", records)
                    .unwrap()
                    .credential(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs())
                    .unwrap()
                    .credential,
            )
            .unwrap()
            .device
            .incarnation;
            Ok(issuer.revoke("current", incarnation).unwrap())
        })
        .unwrap();
    pilot.crypto_directory.lock().unwrap()["revocations"] =
        json!([{"position":"1", "signed":B64.encode(serde_json::to_vec(&signed).unwrap())}]);
    let observer = pilot.session.crypto_settings(Guard::new(), path.clone(), pilot.memory.clone()).await.unwrap();
    assert!(observer.refresh().await.is_err());
    assert!(conversation.check().is_err());
    let writes = pilot.memory.writes.load(Ordering::SeqCst);
    assert!(conversation.publish_packages("1".into(), 1).await.is_err());
    assert_eq!(pilot.memory.writes.load(Ordering::SeqCst), writes);
    assert!(pilot.publications.lock().unwrap().is_empty());
    pilot.crypto_directory.lock().unwrap()["revocations"] = json!([]);
    access.close();
    let reopened = pilot.session.crypto_settings(Guard::new(), path, pilot.memory.clone()).await.unwrap();
    assert!(reopened.refresh().await.is_err());
    assert!(reopened.conversation().await.is_err());
    assert_eq!(pilot.registrations.lock().unwrap().len(), 1);
    pilot.close().await;
}
