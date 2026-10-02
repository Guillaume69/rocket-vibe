mod common;
use common::{FakeHttp, dropped, respond};
use rv_core::native::{
    self,
    authentication_vault::{Storage, StorageFuture},
    email_recovery::{self, Form, Intent, Scope, Vault},
    security::Guard,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::File,
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("rv-recovery-vault-{}-{}", std::process::id(), fastrand::u64(..))))
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[derive(Default)]
struct Block {
    started: tokio::sync::Notify,
    ready: Mutex<bool>,
    wake: Condvar,
}
#[derive(Default)]
struct Memory {
    values: Arc<Mutex<HashMap<String, String>>>,
    writes: Arc<AtomicUsize>,
    fail_write: Arc<AtomicUsize>,
    block: Mutex<Option<Arc<Block>>>,
}
impl Storage for Memory {
    fn read(&self, key: String, lease: Arc<File>) -> StorageFuture<Option<String>> {
        let values = self.values.clone();
        Box::pin(async move {
            let _lease = lease;
            Ok(values.lock().unwrap().get(&key).cloned())
        })
    }
    fn write(&self, key: String, value: String, lease: Arc<File>) -> StorageFuture<()> {
        let (values, writes, fail, block) =
            (self.values.clone(), self.writes.clone(), self.fail_write.clone(), self.block.lock().unwrap().clone());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let _lease = lease;
                if let Some(block) = block {
                    block.started.notify_one();
                    let mut ready = block.ready.lock().unwrap();
                    while !*ready {
                        ready = block.wake.wait(ready).unwrap();
                    }
                }
                let n = writes.fetch_add(1, Ordering::SeqCst) + 1;
                if fail.load(Ordering::SeqCst) == n {
                    return Err(native::Error::Protocol("secure_storage_unavailable"));
                }
                values.lock().unwrap().insert(key, value);
                Ok(())
            })
            .await
            .map_err(|_| native::Error::Protocol("secure_storage_unavailable"))?
        })
    }
    fn remove(&self, key: String, lease: Arc<File>) -> StorageFuture<()> {
        let values = self.values.clone();
        Box::pin(async move {
            let _lease = lease;
            values.lock().unwrap().remove(&key);
            Ok(())
        })
    }
}
fn discovery() -> rv_protocol::Discovery {
    let fixture: Value = serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let mut discovery: rv_protocol::Discovery = serde_json::from_value(fixture["discovery"].clone()).unwrap();
    discovery.capabilities.email_recovery = true;
    discovery
}
struct Harness {
    _server: FakeHttp,
    memory: Arc<Memory>,
    scope: Scope,
    temp: TempDir,
    posts: Arc<AtomicUsize>,
    reads: Arc<AtomicUsize>,
    lose: Arc<AtomicBool>,
    mode: Arc<Mutex<String>>,
    cancel: Arc<Mutex<Option<Guard>>>,
}
impl Harness {
    async fn new() -> Self {
        let (memory, posts, reads, lose, mode, cancel) = (
            Arc::new(Memory::default()),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicBool::new(false)),
            Arc::new(Mutex::new(String::new())),
            Arc::new(Mutex::new(None::<Guard>)),
        );
        let (m, p, r, l, state, closing) =
            (memory.clone(), posts.clone(), reads.clone(), lose.clone(), mode.clone(), cancel.clone());
        let server = FakeHttp::start(move |req| {
            assert!(!req.headers.contains_key("authorization"));
            if req.path() == "/.well-known/rocketvibe" {
                let n = r.fetch_add(1, Ordering::SeqCst) + 1;
                let mode = state.lock().unwrap().clone();
                let mut discovery = discovery();
                if mode == "before" || mode == "staged" && n >= 2 || mode == "after" && p.load(Ordering::SeqCst) > 0 {
                    discovery.data_epoch = "changed".into();
                }
                if mode == "unsupported" || mode == "smtp-gone" && p.load(Ordering::SeqCst) > 0 {
                    discovery.capabilities.email_recovery = false;
                }
                return respond(200, &serde_json::to_string(&discovery).unwrap());
            }
            assert_eq!(req.path(), "/api/v1/auth/recovery/email/start");
            assert_eq!(req.method, "POST");
            p.fetch_add(1, Ordering::SeqCst);
            let input: Value = serde_json::from_str(&req.body).unwrap();
            let values = m.values.lock().unwrap();
            let durable = values.values().any(|raw| {
                let saved: Value = serde_json::from_str(raw).unwrap();
                saved["input"] == input && saved["accepted"] == false
            });
            assert!(durable, "HTTP must follow the original durable command");
            drop(values);
            if let Some(guard) = closing.lock().unwrap().take() {
                guard.cancel();
            }
            if l.swap(false, Ordering::SeqCst) {
                dropped()
            } else if *state.lock().unwrap() == "limited" {
                let mut limited =
                    respond(429, &json!({"code":"auth_rate_limited","request_id":"synthetic-limit"}).to_string());
                limited.headers.push(("Retry-After".into(), "60".into()));
                limited
            } else {
                respond(202, &json!({"accepted":*state.lock().unwrap()!="malformed"}).to_string())
            }
        })
        .await;
        let scope = Scope::new(server.url.as_str(), "alice", &discovery()).unwrap();
        Self { _server: server, memory, scope, temp: TempDir::new(), posts, reads, lose, mode, cancel }
    }
    fn vault(&self) -> Vault {
        Vault::new(self.temp.0.clone(), self.memory.clone())
    }
    async fn pending(&self) -> Intent {
        self.vault().load(self.scope.base_url(), self.scope.username()).await.unwrap().unwrap()
    }
    fn posts(&self) -> usize {
        self.posts.load(Ordering::SeqCst)
    }
}

#[test]
fn namespace_is_canonical_and_separate_from_login_and_active_account() {
    let first = email_recovery::key("https://EXAMPLE.org:443/", "alice").unwrap();
    assert_eq!(first, email_recovery::key("https://example.org", "alice").unwrap());
    for other in [
        email_recovery::key("https://other.org", "alice").unwrap(),
        email_recovery::key("https://example.org", "bob").unwrap(),
        native::authentication_vault::key("https://example.org", "alice").unwrap(),
        email_recovery::key("https://example.org/a", "bc").unwrap(),
        email_recovery::key("https://example.org/ab", "c").unwrap(),
    ] {
        assert_ne!(first, other);
    }
    assert_ne!(
        email_recovery::key("https://example.org/a", "bc").unwrap(),
        email_recovery::key("https://example.org/ab", "c").unwrap()
    );
    assert!(first.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
}

#[tokio::test]
async fn lost_ack_and_recreated_vault_keep_one_command_without_sending_during_reads() {
    let h = Harness::new().await;
    h.lose.store(true, Ordering::SeqCst);
    assert!(h.vault().begin(&h.scope, &Guard::new()).await.is_err());
    let before = h.reads.load(Ordering::SeqCst);
    let saved = h.pending().await;
    assert_eq!(before, h.reads.load(Ordering::SeqCst));
    assert!(!saved.view().accepted);
    let original = serde_json::to_value(&saved).unwrap();
    let resumed = h.vault().retry(&saved, &Guard::new()).await.unwrap();
    assert!(resumed.view().accepted);
    let current = serde_json::to_value(&resumed).unwrap();
    assert!(
        original["input"] == current["input"]
            && original["expires_at"] == current["expires_at"]
            && original["created_at"] == current["created_at"]
    );
    assert_eq!(h.posts(), 2);
    h.vault().retry(&saved, &Guard::new()).await.unwrap();
    assert_eq!(h.posts(), 2);
    let public = format!("{:?}", resumed.view());
    assert!(!public.contains(original["input"]["operation_id"].as_str().unwrap()));
    for entry in std::fs::read_dir(&h.temp.0).unwrap() {
        assert_eq!(entry.unwrap().metadata().unwrap().len(), 0, "Lease files must not contain private records");
    }
}

#[tokio::test]
async fn two_independent_vaults_cannot_replace_the_original_request() {
    let h = Harness::new().await;
    let (first, second) = (h.vault(), h.vault());
    let (first_guard, second_guard) = (Guard::new(), Guard::new());
    let (a, b) = tokio::join!(first.begin(&h.scope, &first_guard), second.begin(&h.scope, &second_guard));
    assert!(a.is_ok() != b.is_ok());
    let refused = if a.is_err() { a.err().unwrap() } else { b.err().unwrap() };
    assert_eq!(refused.code(), "recovery_pending");
    assert_eq!(h.posts(), 1);
}

#[tokio::test]
async fn storage_refusal_prevents_send_and_ack_storage_failure_preserves_retry() {
    let h = Harness::new().await;
    h.memory.fail_write.store(1, Ordering::SeqCst);
    assert_eq!(h.vault().begin(&h.scope, &Guard::new()).await.err().unwrap().code(), "secure_storage_unavailable");
    assert_eq!(h.posts(), 0);
    assert!(h.memory.values.lock().unwrap().is_empty());
    let h = Harness::new().await;
    h.memory.fail_write.store(2, Ordering::SeqCst);
    assert!(h.vault().begin(&h.scope, &Guard::new()).await.is_err());
    let saved = h.pending().await;
    assert!(!saved.view().accepted);
    assert_eq!(h.posts(), 1);
    assert!(h.vault().retry(&saved, &Guard::new()).await.unwrap().view().accepted);
    assert_eq!(h.posts(), 2);
}

#[tokio::test]
async fn generation_and_capability_are_pinned_before_and_after_the_durable_command() {
    for mode in ["before", "unsupported", "staged", "after", "malformed"] {
        let h = Harness::new().await;
        *h.mode.lock().unwrap() = mode.into();
        let error = h.vault().begin(&h.scope, &Guard::new()).await.err().unwrap();
        assert_eq!(
            error.code(),
            match mode {
                "unsupported" => "recovery_unavailable",
                "malformed" => "invalid_native_recovery",
                _ => "server_identity_changed",
            }
        );
        assert_eq!(h.posts(), usize::from(mode == "after" || mode == "malformed"));
        assert_eq!(h.memory.values.lock().unwrap().len(), usize::from(mode != "before" && mode != "unsupported"));
        if mode != "before" && mode != "unsupported" {
            assert!(!h.pending().await.view().accepted);
        }
    }
}

#[tokio::test]
async fn acknowledged_request_remains_generic_if_smtp_disappears() {
    let h = Harness::new().await;
    *h.mode.lock().unwrap() = "smtp-gone".into();
    let saved = h.vault().begin(&h.scope, &Guard::new()).await.unwrap();
    assert!(saved.view().accepted);
    assert!(h.vault().retry(&saved, &Guard::new()).await.unwrap().view().accepted);
    assert_eq!(h.posts(), 1);
}

#[tokio::test]
async fn expiry_requires_explicit_dismissal_and_an_old_view_cannot_delete_the_next_request() {
    let h = Harness::new().await;
    h.lose.store(true, Ordering::SeqCst);
    assert!(h.vault().begin(&h.scope, &Guard::new()).await.is_err());
    let saved = h.pending().await;
    let mut expired = serde_json::to_value(saved).unwrap();
    let now = chrono::Utc::now();
    expired["created_at"] = json!((now - chrono::Duration::hours(2)).timestamp_millis());
    expired["expires_at"] = json!((now - chrono::Duration::hours(1)).timestamp_millis());
    h.memory
        .values
        .lock()
        .unwrap()
        .insert(email_recovery::key(h.scope.base_url(), h.scope.username()).unwrap(), expired.to_string());
    let old = h.pending().await;
    assert!(old.view().expired);
    assert_eq!(h.vault().retry(&old, &Guard::new()).await.err().unwrap().code(), "recovery_expired");
    assert_eq!(h.vault().begin(&h.scope, &Guard::new()).await.err().unwrap().code(), "recovery_pending");
    assert_eq!(h.posts(), 1);
    assert!(h.vault().forget(&old, &Guard::new()).await.unwrap());
    let next = h.vault().begin(&h.scope, &Guard::new()).await.unwrap();
    assert_eq!(h.posts(), 2);
    assert!(!h.vault().forget(&old, &Guard::new()).await.unwrap());
    assert_eq!(h.vault().retry(&old, &Guard::new()).await.err().unwrap().code(), "credentials_changed");
    let actual = h.pending().await;
    assert!(serde_json::to_value(&actual).unwrap() == serde_json::to_value(&next).unwrap());
}

#[tokio::test]
async fn corrupt_or_foreign_storage_fails_closed_without_making_a_new_request() {
    for field in ["password", "scope", "input", "expires_at"] {
        let h = Harness::new().await;
        let saved = h.vault().begin(&h.scope, &Guard::new()).await.unwrap();
        let mut corrupt = serde_json::to_value(&saved).unwrap();
        match field {
            "password" => corrupt["password"] = json!("forged"),
            "scope" => corrupt["scope"]["username"] = json!("bob"),
            "input" => corrupt["input"]["address"] = json!("forged@example.test"),
            _ => corrupt["expires_at"] = json!(chrono::Utc::now().timestamp_millis()),
        }
        h.memory
            .values
            .lock()
            .unwrap()
            .insert(email_recovery::key(h.scope.base_url(), h.scope.username()).unwrap(), corrupt.to_string());
        assert_eq!(
            h.vault().load(h.scope.base_url(), h.scope.username()).await.err().unwrap().code(),
            "invalid_native_recovery"
        );
        assert_eq!(h.vault().retry(&saved, &Guard::new()).await.err().unwrap().code(), "invalid_native_recovery");
        assert_eq!(h.posts(), 1);
    }
}

#[tokio::test]
async fn retry_after_survives_vault_recreation_and_keeps_the_original_deadline() {
    let h = Harness::new().await;
    *h.mode.lock().unwrap() = "limited".into();
    assert_eq!(h.vault().begin(&h.scope, &Guard::new()).await.err().unwrap().code(), "auth_rate_limited");
    let saved = h.pending().await;
    assert!(saved.view().retry_after_seconds > 0 && saved.view().retry_after_seconds <= 60);
    let reads = h.reads.load(Ordering::SeqCst);
    assert_eq!(h.vault().retry(&saved, &Guard::new()).await.err().unwrap().code(), "email_recovery_cooldown");
    assert_eq!(h.posts(), 1);
    assert_eq!(h.reads.load(Ordering::SeqCst), reads);
    let mut expired = serde_json::to_value(&saved).unwrap();
    expired["retry_at"] = expired["created_at"].clone();
    h.memory
        .values
        .lock()
        .unwrap()
        .insert(email_recovery::key(h.scope.base_url(), h.scope.username()).unwrap(), expired.to_string());
    *h.mode.lock().unwrap() = String::new();
    let accepted = h.vault().retry(&saved, &Guard::new()).await.unwrap();
    let actual = serde_json::to_value(&accepted).unwrap();
    let original = serde_json::to_value(&saved).unwrap();
    assert!(accepted.view().accepted && accepted.view().retry_after_seconds == 0);
    assert!(actual["expires_at"] == original["expires_at"] && actual["input"] == original["input"]);
    assert_eq!(h.posts(), 2);
}

#[tokio::test]
async fn transport_mail_recovery_cooldown_is_shared_by_clones_without_blocking_discovery() {
    let posts = Arc::new(AtomicUsize::new(0));
    let count = posts.clone();
    let server = FakeHttp::start(move |req| {
        if req.path() == "/.well-known/rocketvibe" {
            return respond(200, &serde_json::to_string(&discovery()).unwrap());
        }
        assert!(!req.headers.contains_key("authorization"));
        count.fetch_add(1, Ordering::SeqCst);
        let mut limited =
            respond(429, &json!({"code":"email_recovery_limit","request_id":"synthetic-limit"}).to_string());
        limited.headers.push(("Retry-After".into(), "60".into()));
        limited
    })
    .await;
    let client = rv_client::NativeClient::new(server.url.as_str()).unwrap();
    let input = rv_protocol::parity::RequestEmailRecovery {
        operation_id: "a".repeat(64),
        username: "alice".into(),
        instance_id: discovery().instance_id,
        data_epoch: discovery().data_epoch,
    };
    assert!(client.request_email_recovery(&input).await.is_err());
    assert!(client.clone().request_email_recovery(&input).await.is_err());
    assert_eq!(posts.load(Ordering::SeqCst), 1);
    assert!(client.discover().await.unwrap().capabilities.email_recovery);
    assert_eq!(posts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancelled_guard_after_http_keeps_the_original_ambiguous_request() {
    let h = Harness::new().await;
    let guard = Guard::new();
    *h.cancel.lock().unwrap() = Some(guard.clone());
    assert_eq!(h.vault().begin(&h.scope, &guard).await.err().unwrap().code(), "session_closed");
    let saved = h.pending().await;
    assert!(!saved.view().accepted);
    assert!(h.vault().retry(&saved, &Guard::new()).await.unwrap().view().accepted);
    assert_eq!(h.posts(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_caller_does_not_release_a_lease_held_by_the_actual_secure_write() {
    let h = Harness::new().await;
    let blocked = Arc::new(Block::default());
    *h.memory.block.lock().unwrap() = Some(blocked.clone());
    let (vault, scope) = (h.vault(), h.scope.clone());
    let task = tokio::spawn(async move { vault.begin(&scope, &Guard::new()).await });
    tokio::time::timeout(std::time::Duration::from_secs(2), blocked.started.notified()).await.unwrap();
    task.abort();
    assert!(task.await.err().unwrap().is_cancelled());
    let probe = File::options()
        .read(true)
        .write(true)
        .open(h.temp.0.join(format!("{}.lock", email_recovery::key(h.scope.base_url(), h.scope.username()).unwrap())))
        .unwrap();
    assert!(
        matches!(probe.try_lock(), Err(std::fs::TryLockError::WouldBlock)),
        "The actual storage job must still hold its OS lease"
    );
    let (vault, scope) = (h.vault(), h.scope.clone());
    let following = tokio::spawn(async move { vault.load(scope.base_url(), scope.username()).await });
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    assert!(!following.is_finished(), "The recreated vault must wait for the real storage job");
    *blocked.ready.lock().unwrap() = true;
    blocked.wake.notify_all();
    let saved = following.await.unwrap().unwrap().unwrap();
    assert!(!saved.view().accepted);
    assert_eq!(h.posts(), 0);
    *h.memory.block.lock().unwrap() = None;
    assert!(h.vault().retry(&saved, &Guard::new()).await.unwrap().view().accepted);
    assert_eq!(h.posts(), 1);
}

#[tokio::test]
async fn form_open_is_local_and_restarted_form_resumes_original_lost_ack_with_revision_fences() {
    let h = Harness::new().await;
    let first = Form::open(h.vault(), h.scope.clone()).await.unwrap();
    assert_eq!(h.reads.load(Ordering::SeqCst), 0);
    assert!(!first.view().unwrap().requested);
    h.lose.store(true, Ordering::SeqCst);
    assert!(first.submit(0).await.is_err());
    let pending = first.view().unwrap();
    assert!(pending.requested && !pending.accepted);
    assert_eq!(first.submit(0).await.err().unwrap().code(), "credentials_changed");
    assert_eq!(h.posts(), 1);
    first.close();
    assert!(first.view().is_none());
    let reads = h.reads.load(Ordering::SeqCst);
    let resumed = Form::open(h.vault(), h.scope.clone()).await.unwrap();
    assert_eq!(h.reads.load(Ordering::SeqCst), reads);
    assert!(resumed.view().unwrap().requested);
    resumed.submit(0).await.unwrap();
    let accepted = resumed.view().unwrap();
    assert!(accepted.accepted);
    assert!(!format!("{accepted:?}").contains("operation_id"));
    assert_eq!(h.posts(), 2);
    resumed.submit(accepted.revision).await.unwrap();
    assert_eq!(h.posts(), 2, "An acknowledged form cannot create another mail");
    let revision = resumed.view().unwrap().revision;
    resumed.forget(revision).await.unwrap();
    assert!(!resumed.view().unwrap().requested);
    assert_eq!(h.posts(), 2, "Dismissal is local");
    assert_eq!(resumed.forget(revision).await.err().unwrap().code(), "credentials_changed");
}

#[tokio::test]
async fn form_for_another_server_generation_cannot_retry_and_stale_dismissal_cannot_erase_a_new_intent() {
    let h = Harness::new().await;
    h.vault().begin(&h.scope, &Guard::new()).await.unwrap();
    let old = Form::open(h.vault(), h.scope.clone()).await.unwrap();
    let changed = Scope::from_identity(
        h.scope.base_url(),
        h.scope.username(),
        &native::Identity { instance_id: h.scope.identity().instance_id.clone(), data_epoch: "replaced".into() },
    )
    .unwrap();
    let changed = Form::open(h.vault(), changed).await.unwrap();
    assert!(changed.view().unwrap().identity_changed);
    let before = h.reads.load(Ordering::SeqCst);
    assert_eq!(changed.submit(0).await.err().unwrap().code(), "server_identity_changed");
    assert_eq!(h.posts(), 1);
    assert_eq!(h.reads.load(Ordering::SeqCst), before);
    changed.forget(changed.view().unwrap().revision).await.unwrap();
    h.vault().begin(&h.scope, &Guard::new()).await.unwrap();
    assert_eq!(old.forget(0).await.err().unwrap().code(), "credentials_changed");
    assert!(h.pending().await.view().accepted, "The newer request stays durable");
    assert_eq!(h.posts(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_form_during_actual_keyring_write_keeps_candidate_but_prevents_late_mail() {
    let h = Harness::new().await;
    let form = Arc::new(Form::open(h.vault(), h.scope.clone()).await.unwrap());
    let blocked = Arc::new(Block::default());
    *h.memory.block.lock().unwrap() = Some(blocked.clone());
    let actual = form.clone();
    let job = tokio::spawn(async move { actual.submit(0).await });
    tokio::time::timeout(std::time::Duration::from_secs(2), blocked.started.notified()).await.unwrap();
    form.close();
    *blocked.ready.lock().unwrap() = true;
    blocked.wake.notify_all();
    assert_eq!(job.await.unwrap().err().unwrap().code(), "session_closed");
    assert!(form.view().is_none());
    assert!(h.vault().load(h.scope.base_url(), h.scope.username()).await.unwrap().is_some());
    assert_eq!(h.posts(), 0);
}
