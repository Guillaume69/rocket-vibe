mod common;
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
