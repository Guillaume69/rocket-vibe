use rv_core::native::{
    Error,
    authentication_vault::{Storage, StorageFuture},
    security::{
        Guard, RemoteFuture, Scope, Vault,
        email::{Remote, State},
    },
};
use rv_protocol::parity::*;
use std::{
    collections::HashMap,
    fs::File,
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

const CODE: &str = "13572468";
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("rv-email-{}-{}", std::process::id(), fastrand::u64(..))))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        if let (Ok(path), Ok(base)) = (self.0.canonicalize(), std::env::temp_dir().canonicalize())
            && path.parent() == Some(base.as_path())
            && path.file_name().is_some_and(|v| v.to_string_lossy().starts_with("rv-email-"))
        {
            let _ = std::fs::remove_dir_all(path);
        }
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
    fail: Arc<AtomicBool>,
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
        let (values, fail, block) = (self.values.clone(), self.fail.clone(), self.block.lock().unwrap().clone());
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
                if fail.load(Ordering::SeqCst) {
                    return Err(Error::Protocol("secure_storage_unavailable"));
                }
                values.lock().unwrap().insert(key, value);
                Ok(())
            })
            .await
            .map_err(|_| Error::Protocol("secure_storage_unavailable"))?
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
fn scope() -> Scope {
    Scope::new(
        "https://example.org",
        ReauthenticationContext {
            user_id: "alice".into(),
            device_id: "desktop".into(),
            instance_id: "instance".into(),
            data_epoch: "epoch".into(),
        },
    )
    .unwrap()
}
fn error(status: u16, code: &str) -> Error {
    Error::Network(rv_client::Error::Server { status, code: code.into(), request_id: None, retry_after: None })
}
struct ServerState {
    status: EmailStatus,
    claimed: bool,
    rows: HashMap<String, EmailVerificationStep>,
}
#[derive(Clone)]
struct Server {
    state: Arc<Mutex<ServerState>>,
    memory: Arc<Memory>,
    starts: Arc<AtomicUsize>,
    confirms: Arc<AtomicUsize>,
    lose_start: Arc<AtomicBool>,
    lose_confirm: Arc<AtomicBool>,
    before_start: Arc<AtomicBool>,
    cancel: Arc<Mutex<Option<Guard>>>,
}
impl Server {
    fn new(memory: Arc<Memory>) -> Self {
        Self {
            state: Arc::new(Mutex::new(ServerState {
                status: EmailStatus {
                    address: None,
                    verified_at: None,
                    version: "contact".into(),
                    verification_version: "head".into(),
                    context: scope().context(),
                },
                claimed: false,
                rows: HashMap::new(),
            })),
            memory,
            starts: Arc::default(),
            confirms: Arc::default(),
            lose_start: Arc::default(),
            lose_confirm: Arc::default(),
            before_start: Arc::default(),
            cancel: Arc::default(),
        }
    }
    fn saved(&self, candidate: &str, operation: &str) {
        assert!(self.memory.values.lock().unwrap().values().any(|raw| {
            let value: serde_json::Value = serde_json::from_str(raw).unwrap();
            value["input"]["verification_id"] == candidate && value["input"]["operation_id"] == operation
        }));
    }
    fn status_value(&self) -> EmailStatus {
        self.state.lock().unwrap().status.clone()
    }
}
impl Remote for Server {
    fn status(&self) -> RemoteFuture<EmailStatus> {
        let result = self.status_value();
        Box::pin(async move { Ok(result) })
    }
    fn begin(&self, input: BeginEmailVerification) -> RemoteFuture<EmailVerificationStep> {
        let s = self.clone();
        Box::pin(async move {
            s.saved(&input.verification_id, &input.operation_id);
            s.starts.fetch_add(1, Ordering::SeqCst);
            if input.address.contains("@@") {
                return Err(error(400, "invalid_request"));
            }
            if s.before_start.swap(false, Ordering::SeqCst) {
                return Err(Error::Protocol("network_or_protocol_error"));
            }
            let result = {
                let mut state = s.state.lock().unwrap();
                if let Some(found) = state.rows.get(&input.verification_id) {
                    return Ok(found.clone());
                }
                if state.claimed
                    || state.status.version != input.expected_version
                    || state.status.verification_version != input.verification_version
                {
                    return Err(error(409, "operation_conflict"));
                }
                let result = EmailVerificationStep::Pending {
                    verification_id: input.verification_id.clone(),
                    operation_id: input.operation_id,
                    address: input.address,
                    expected_version: input.expected_version,
                    verification_version: input.verification_version,
                    delivery: EmailDeliveryState::Queued,
                    expires_at: "2000-01-01T00:15:00Z".into(),
                };
                state.claimed = true;
                state.rows.insert(input.verification_id, result.clone());
                result
            };
            if s.lose_start.swap(false, Ordering::SeqCst) {
                return Err(Error::Protocol("network_or_protocol_error"));
            }
            Ok(result)
        })
    }
    fn resume(&self, input: ResumeEmailVerification) -> RemoteFuture<EmailVerificationStep> {
        let result = self.state.lock().unwrap().rows.get(&input.verification_id).cloned();
        Box::pin(async move { result.ok_or_else(|| error(400, "email_verification_rejected")) })
    }
    fn confirm(&self, input: ConfirmEmailVerification) -> RemoteFuture<EmailVerificationStep> {
        let s = self.clone();
        Box::pin(async move {
            s.saved(&input.verification_id, &input.operation_id);
            assert!(!s.memory.values.lock().unwrap().values().any(|raw| raw.contains(CODE)));
            let result = {
                let mut state = s.state.lock().unwrap();
                let found = state
                    .rows
                    .get(&input.verification_id)
                    .cloned()
                    .ok_or_else(|| error(400, "email_verification_rejected"))?;
                if matches!(found, EmailVerificationStep::Verified { .. }) {
                    return Ok(found);
                }
                if input.code != CODE {
                    return Err(error(400, "email_verification_rejected"));
                }
                let EmailVerificationStep::Pending { address, .. } = found else { unreachable!() };
                let count = s.confirms.fetch_add(1, Ordering::SeqCst) + 1;
                state.status.address = Some(address.clone());
                state.status.verified_at = Some("2026-10-01T00:00:00Z".into());
                state.status.version = format!("contact-{count}");
                state.status.verification_version = format!("accepted-{count}");
                state.claimed = false;
                let result = EmailVerificationStep::Verified { address, version: state.status.version.clone() };
                state.rows.insert(input.verification_id, result.clone());
                result
            };
            if let Some(guard) = s.cancel.lock().unwrap().take() {
                guard.cancel();
            }
            if s.lose_confirm.swap(false, Ordering::SeqCst) {
                return Err(Error::Protocol("network_or_protocol_error"));
            }
            Ok(result)
        })
    }
    fn retire(&self, input: RetireEmailVerification) -> RemoteFuture<EmailStatus> {
        let result = {
            let mut state = self.state.lock().unwrap();
            if state.status.verification_version == input.verification_version {
                state.status.verification_version = format!("retired-{}", fastrand::u64(..));
                state.claimed = false;
                state.rows.retain(|_, v| matches!(v, EmailVerificationStep::Verified { .. }));
            }
            state.status.clone()
        };
        Box::pin(async move { Ok(result) })
    }
}
fn fixture() -> (Temp, Arc<Memory>, Server, Vault) {
    let temp = Temp::new();
    let memory = Arc::new(Memory::default());
    let server = Server::new(memory.clone());
    let vault = Vault::new(temp.0.clone(), memory.clone());
    (temp, memory, server, vault)
}
fn receipt(state: &State) -> String {
    state.receipt().expect("receipt").into()
}

#[tokio::test]
async fn lost_replies_preserve_original_intent_and_code_never_enters_private_storage() {
    let (temp, memory, server, vault) = fixture();
    let guard = Guard::new();
    server.lose_start.store(true, Ordering::SeqCst);
    assert!(vault.email_start(&scope(), &server, "Alice@EXAMPLE.ORG", &server.status_value(), &guard).await.is_err());
    let vault = Vault::new(temp.0.clone(), memory.clone());
    let pending = vault.email_resume(&scope(), &server, &guard).await.unwrap();
    assert!(matches!(pending.state,State::Pending{ref address,..} if address=="Alice@example.org"));
    assert_eq!(server.starts.load(Ordering::SeqCst), 1);
    server.lose_confirm.store(true, Ordering::SeqCst);
    assert!(vault.email_confirm(&scope(), &server, &receipt(&pending.state), CODE, &guard).await.is_err());
    let verified = vault.email_resume(&scope(), &server, &guard).await.unwrap();
    assert!(matches!(verified.state, State::Verified { .. }));
    assert_eq!(server.confirms.load(Ordering::SeqCst), 1);
    assert!(!memory.values.lock().unwrap().values().any(|raw| raw.contains(CODE)));
    vault.email_acknowledge(&scope(), &server, &receipt(&verified.state), &guard).await.unwrap();
    assert!(memory.values.lock().unwrap().is_empty());
}
#[tokio::test]
async fn unreceived_start_retries_exact_candidate_but_pruned_expiry_does_not_reopen_it() {
    let (_temp, _memory, server, vault) = fixture();
    let guard = Guard::new();
    server.before_start.store(true, Ordering::SeqCst);
    assert!(vault.email_start(&scope(), &server, "first@example.org", &server.status_value(), &guard).await.is_err());
    let pending = vault.email_resume(&scope(), &server, &guard).await.unwrap();
    assert!(matches!(pending.state, State::Pending { .. }));
    assert_eq!(server.starts.load(Ordering::SeqCst), 2);
    server.state.lock().unwrap().rows.clear();
    let stale = vault.email_resume(&scope(), &server, &guard).await.unwrap();
    assert!(matches!(stale.state, State::Stale { .. }));
    assert_eq!(server.starts.load(Ordering::SeqCst), 2);
    vault.email_cancel(&scope(), &server, &receipt(&stale.state), &guard).await.unwrap();
    assert!(matches!(
        vault.email_start(&scope(), &server, "second@example.org", &server.status_value(), &guard).await.unwrap().state,
        State::Pending { .. }
    ));
}
#[tokio::test]
async fn stale_receipts_cannot_cancel_confirm_or_erase_a_replacement() {
    let (_temp, memory, server, vault) = fixture();
    let guard = Guard::new();
    let first =
        vault.email_start(&scope(), &server, "first@example.org", &server.status_value(), &guard).await.unwrap();
    let old = receipt(&first.state);
    vault.email_cancel(&scope(), &server, &old, &guard).await.unwrap();
    let next =
        vault.email_start(&scope(), &server, "second@example.org", &server.status_value(), &guard).await.unwrap();
    assert!(vault.email_cancel(&scope(), &server, &old, &guard).await.is_err());
    assert!(vault.email_confirm(&scope(), &server, &old, CODE, &guard).await.is_err());
    assert!(vault.email_acknowledge(&scope(), &server, &old, &guard).await.is_err());
    assert_eq!(memory.values.lock().unwrap().len(), 1);
    assert!(receipt(&next.state) != old);
    assert_eq!(server.confirms.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn accepted_receipt_survives_pruning_and_is_never_relabeled_after_contact_changes() {
    let (_temp, _memory, server, vault) = fixture();
    let guard = Guard::new();
    let first =
        vault.email_start(&scope(), &server, "first@example.org", &server.status_value(), &guard).await.unwrap();
    vault.email_confirm(&scope(), &server, &receipt(&first.state), CODE, &guard).await.unwrap();
    server.state.lock().unwrap().rows.clear();
    assert!(matches!(vault.email_resume(&scope(), &server, &guard).await.unwrap().state, State::Verified { .. }));
    {
        let mut s = server.state.lock().unwrap();
        s.status.version = "another-contact".into();
        s.status.address = Some("second@example.org".into());
    }
    let view = vault.email_resume(&scope(), &server, &guard).await.unwrap();
    assert!(matches!(view.state, State::Stale { .. }));
    assert!(view.status.address.as_deref() == Some("second@example.org"));
}
#[tokio::test]
async fn cancelled_confirmation_keeps_original_candidate_for_a_new_guard() {
    let (temp, memory, server, vault) = fixture();
    let guard = Guard::new();
    let first =
        vault.email_start(&scope(), &server, "first@example.org", &server.status_value(), &guard).await.unwrap();
    *server.cancel.lock().unwrap() = Some(guard.clone());
    assert!(vault.email_confirm(&scope(), &server, &receipt(&first.state), CODE, &guard).await.is_err());
    assert!(
        memory
            .values
            .lock()
            .unwrap()
            .values()
            .all(|raw| serde_json::from_str::<serde_json::Value>(raw).unwrap()["accepted"].is_null())
    );
    let vault = Vault::new(temp.0.clone(), memory);
    assert!(matches!(
        vault.email_resume(&scope(), &server, &Guard::new()).await.unwrap().state,
        State::Verified { .. }
    ));
    assert_eq!(server.confirms.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn rejected_addresses_and_storage_failures_are_recoverable_without_blind_replacement() {
    let (_temp, memory, server, vault) = fixture();
    let guard = Guard::new();
    memory.fail.store(true, Ordering::SeqCst);
    assert!(vault.email_start(&scope(), &server, "first@example.org", &server.status_value(), &guard).await.is_err());
    assert_eq!(server.starts.load(Ordering::SeqCst), 0);
    memory.fail.store(false, Ordering::SeqCst);
    let bad = vault.email_start(&scope(), &server, "bad@@example.org", &server.status_value(), &guard).await.unwrap();
    assert!(matches!(bad.state, State::Stale { .. }));
    vault.email_cancel(&scope(), &server, &receipt(&bad.state), &guard).await.unwrap();
    assert!(memory.values.lock().unwrap().is_empty());
    assert!(matches!(
        vault.email_start(&scope(), &server, "good@example.org", &server.status_value(), &guard).await.unwrap().state,
        State::Pending { .. }
    ));
}
#[tokio::test]
async fn deadline_and_identity_changes_fail_closed_without_erasing_private_intent() {
    let (_temp, memory, server, vault) = fixture();
    let guard = Guard::new();
    vault.email_start(&scope(), &server, "first@example.org", &server.status_value(), &guard).await.unwrap();
    let before = memory.values.lock().unwrap().clone();
    for row in server.state.lock().unwrap().rows.values_mut() {
        if let EmailVerificationStep::Pending { expires_at, .. } = row {
            *expires_at = "2000-01-01T00:30:00Z".into();
        }
    }
    assert!(vault.email_resume(&scope(), &server, &guard).await.is_err());
    assert!(memory.values.lock().unwrap().iter().all(|(k, v)| before.get(k) == Some(v)));
    server.state.lock().unwrap().status.context.user_id = "another-user".into();
    assert!(vault.email_resume(&scope(), &server, &guard).await.is_err());
    assert_eq!(server.starts.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn two_vaults_share_one_os_lease_and_cannot_replace_a_pending_address() {
    let (temp, memory, server, first) = fixture();
    let second = Vault::new(temp.0.clone(), memory);
    let expected = server.status_value();
    let scope = scope();
    let guard = Guard::new();
    let (a, b) = tokio::join!(
        first.email_start(&scope, &server, "first@example.org", &expected, &guard),
        second.email_start(&scope, &server, "second@example.org", &expected, &guard)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert!(receipt(&a.state) == receipt(&b.state));
    assert_eq!(server.starts.load(Ordering::SeqCst), 1);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aborted_caller_cannot_release_lease_while_private_platform_write_still_runs() {
    let (temp, memory, server, vault) = fixture();
    let block = Arc::new(Block::default());
    *memory.block.lock().unwrap() = Some(block.clone());
    let remote = server.clone();
    let first = tokio::spawn(async move {
        vault.email_start(&scope(), &remote, "first@example.org", &remote.status_value(), &Guard::new()).await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), block.started.notified()).await.unwrap();
    first.abort();
    let _ = first.await;
    *memory.block.lock().unwrap() = None;
    let second = Vault::new(temp.0.clone(), memory.clone());
    let remote = server.clone();
    let second = tokio::spawn(async move {
        second.email_start(&scope(), &remote, "replacement@example.org", &remote.status_value(), &Guard::new()).await
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(!second.is_finished());
    assert_eq!(server.starts.load(Ordering::SeqCst), 0);
    *block.ready.lock().unwrap() = true;
    block.wake.notify_all();
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), second).await.unwrap().unwrap().unwrap();
    assert!(matches!(result.state,State::Pending{ref address,..} if address=="first@example.org"));
    assert_eq!(server.starts.load(Ordering::SeqCst), 1);
}
