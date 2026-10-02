use rv_core::native::{
    Error,
    authentication_vault::{Storage, StorageFuture},
    security::{FactorAction, FactorState, Guard, ProofState, Remote, RemoteFuture, Scope, Vault},
};
use rv_protocol::parity::*;
use serde_json::json;
use std::{
    collections::HashMap,
    fs::File,
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("rv-security-{}-{}", std::process::id(), fastrand::u64(..))))
    }
}
impl Drop for Temp {
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
    fail: Arc<AtomicBool>,
    block: Mutex<Option<Arc<Block>>>,
}
impl Storage for Memory {
    fn read(&self, key: String, lease: Arc<File>) -> StorageFuture<Option<String>> {
        let (values, fail) = (self.values.clone(), self.fail.clone());
        Box::pin(async move {
            let _lease = lease;
            if fail.load(Ordering::SeqCst) {
                return Err(Error::Protocol("secure_storage_unavailable"));
            }
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
fn context() -> ReauthenticationContext {
    ReauthenticationContext {
        user_id: "alice".into(),
        device_id: "mobile".into(),
        instance_id: "instance".into(),
        data_epoch: "epoch".into(),
    }
}
fn scope() -> Scope {
    Scope::new("https://example.org", context()).unwrap()
}
#[tokio::test]
async fn email_proof_recovers_lost_delivery_and_verification_without_changing_family_or_original_intent() {
    let temp = Temp::new();
    let memory = Arc::new(Memory::default());
    let server = Server::new(memory.clone());
    server.email_available.store(true, Ordering::SeqCst);
    let vault = Vault::new(temp.0.clone(), memory.clone());
    let guard = Guard::new();
    let ProofState::Challenge(original) = vault.prepare(&scope(), &server, "PRIVATE-PASSWORD", &guard).await.unwrap()
    else {
        panic!()
    };
    server.lose_mail.store(true, Ordering::SeqCst);
    assert_eq!(vault.send_email(&original, &server, false, &guard).await.err().unwrap().code(), "connection_failed");
    let recreated = Vault::new(temp.0.clone(), memory.clone());
    let ProofState::Challenge(restored) = recreated.prepare(&scope(), &server, "", &guard).await.unwrap() else {
        panic!()
    };
    assert!(restored.email().unwrap().status.is_none());
    let ProofState::Challenge(sent) = recreated.send_email(&restored, &server, false, &guard).await.unwrap() else {
        panic!()
    };
    assert!(restored.email().unwrap().same_candidate(sent.email().unwrap()));
    assert_eq!(sent.challenge().unwrap().expires_at, original.challenge().unwrap().expires_at);
    assert_eq!(server.mail_starts.load(Ordering::SeqCst), 1);
    assert_eq!(server.starts.load(Ordering::SeqCst), 1);
    server.lose_finish.store(true, Ordering::SeqCst);
    assert_eq!(
        recreated.finish(&sent, &server, SecondFactor::Email, "PRIVATE-EMAIL-CODE", &guard).await.err().unwrap().code(),
        "connection_failed"
    );
    assert!(matches!(recreated.prepare(&scope(), &server, "", &guard).await.unwrap(), ProofState::Ready));
    assert_eq!(server.finishes.load(Ordering::SeqCst), 1);
    assert!(memory.values.lock().unwrap().is_empty());
}
#[tokio::test]
async fn email_proof_keeps_an_existing_delivered_method_after_smtp_disappears_and_fences_stale_resends() {
    let temp = Temp::new();
    let memory = Arc::new(Memory::default());
    let server = Server::new(memory.clone());
    server.email_available.store(true, Ordering::SeqCst);
    let vault = Vault::new(temp.0.clone(), memory);
    let guard = Guard::new();
    let ProofState::Challenge(original) = vault.prepare(&scope(), &server, "PRIVATE-PASSWORD", &guard).await.unwrap()
    else {
        panic!()
    };
    let ProofState::Challenge(sent) = vault.send_email(&original, &server, false, &guard).await.unwrap() else {
        panic!()
    };
    let ProofState::Challenge(resent) = vault.send_email(&sent, &server, true, &guard).await.unwrap() else { panic!() };
    assert!(!sent.email().unwrap().same_candidate(resent.email().unwrap()));
    assert_eq!(vault.send_email(&sent, &server, true, &guard).await.err().unwrap().code(), "credentials_changed");
    assert_eq!(server.mail_starts.load(Ordering::SeqCst), 2);
    server.email_available.store(false, Ordering::SeqCst);
    let ProofState::Challenge(retained) = vault.prepare(&scope(), &server, "", &guard).await.unwrap() else { panic!() };
    assert!(retained.challenge().unwrap().methods.iter().any(|m| matches!(m, SecondFactor::Email)));
    assert!(matches!(
        vault.finish(&retained, &server, SecondFactor::Email, "PRIVATE-EMAIL-CODE", &guard).await.unwrap(),
        ProofState::Ready
    ));
    assert_eq!(server.mail_starts.load(Ordering::SeqCst), 2);
    let fresh_memory = Arc::new(Memory::default());
    let fresh_server = Server::new(fresh_memory.clone());
    let ProofState::Challenge(fresh) = Vault::new(temp.0.clone(), fresh_memory)
        .prepare(&scope(), &fresh_server, "PRIVATE-PASSWORD", &guard)
        .await
        .unwrap()
    else {
        panic!()
    };
    assert!(!fresh.challenge().unwrap().methods.iter().any(|m| matches!(m, SecondFactor::Email)));
}
fn error(status: u16, code: &str) -> Error {
    Error::Network(rv_client::Error::Server { status, code: code.into(), request_id: None, retry_after: None })
}
#[derive(Default)]
struct State {
    head: String,
    recent: bool,
    pending: HashMap<String, BeginReauthentication>,
    challenges: HashMap<String, AuthChallenge>,
    deliveries: HashMap<String, RequestFactorEmail>,
    grants: HashMap<String, ReauthenticationGrant>,
    factor_version: Option<String>,
    bags: HashMap<String, FactorBackupCodes>,
}
#[derive(Clone)]
struct Server {
    state: Arc<Mutex<State>>,
    memory: Arc<Memory>,
    starts: Arc<AtomicUsize>,
    finishes: Arc<AtomicUsize>,
    regenerations: Arc<AtomicUsize>,
    disables: Arc<AtomicUsize>,
    lose_start: Arc<AtomicBool>,
    lose_finish: Arc<AtomicBool>,
    lose_enable: Arc<AtomicBool>,
    lose_regenerate: Arc<AtomicBool>,
    lose_disable: Arc<AtomicBool>,
    cancel_enable: Arc<Mutex<Option<Guard>>>,
    change_enable: Arc<AtomicBool>,
    email_available: Arc<AtomicBool>,
    mail_starts: Arc<AtomicUsize>,
    lose_mail: Arc<AtomicBool>,
}
impl Server {
    fn new(memory: Arc<Memory>) -> Self {
        Self {
            state: Arc::new(Mutex::new(State { head: "initial".into(), ..State::default() })),
            memory,
            starts: Arc::default(),
            finishes: Arc::default(),
            regenerations: Arc::default(),
            disables: Arc::default(),
            lose_start: Arc::default(),
            lose_finish: Arc::default(),
            lose_enable: Arc::default(),
            lose_regenerate: Arc::default(),
            lose_disable: Arc::default(),
            cancel_enable: Arc::default(),
            change_enable: Arc::default(),
            email_available: Arc::default(),
            mail_starts: Arc::default(),
            lose_mail: Arc::default(),
        }
    }
    fn status_value(&self) -> ReauthenticationStatus {
        let s = self.state.lock().unwrap();
        ReauthenticationStatus {
            user_id: "alice".into(),
            device_id: "mobile".into(),
            instance_id: "instance".into(),
            data_epoch: "epoch".into(),
            proof_version: s.head.clone(),
            recent: s.recent,
        }
    }
    fn has_operation(&self, op: &str) -> bool {
        self.memory.values.lock().unwrap().values().any(|raw| raw.contains(op))
    }
    fn challenge(input: &BeginReauthentication) -> ReauthenticationStep {
        ReauthenticationStep::Challenge {
            challenge: AuthChallenge {
                challenge_id: input.challenge_id.clone(),
                methods: vec![SecondFactor::Totp, SecondFactor::RecoveryCode],
                expires_at: (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339(),
                resend_after_seconds: 0,
            },
        }
    }
    fn bag(state: &mut State, operation: &str) -> FactorBackupCodes {
        let version = format!("revision-{operation}");
        let bag = FactorBackupCodes {
            codes: (0..10).map(|i| format!("PRIVATE-BACKUP-{i}")).collect(),
            factor_version: Some(version.clone()),
        };
        state.factor_version = Some(version);
        state.bags.insert(operation.into(), bag.clone());
        bag
    }
}
impl Remote for Server {
    fn status(&self) -> RemoteFuture<ReauthenticationStatus> {
        let s = self.clone();
        Box::pin(async move { Ok(s.status_value()) })
    }
    fn begin(&self, input: BeginReauthentication) -> RemoteFuture<ReauthenticationStep> {
        let s = self.clone();
        Box::pin(async move {
            s.starts.fetch_add(1, Ordering::SeqCst);
            assert!(s.has_operation(&input.challenge_id));
            assert!(!s.memory.values.lock().unwrap().values().any(|raw| raw.contains("\"password\":")));
            let mut state = s.state.lock().unwrap();
            assert_eq!(state.head, input.proof_version);
            state.pending.insert(input.challenge_id.clone(), input.clone());
            let ReauthenticationStep::Challenge { mut challenge } = Self::challenge(&input) else { unreachable!() };
            if s.email_available.load(Ordering::SeqCst) {
                challenge.methods.push(SecondFactor::Email);
            }
            state.challenges.insert(input.challenge_id.clone(), challenge.clone());
            if s.lose_start.swap(false, Ordering::SeqCst) {
                return Err(Error::Protocol("connection_failed"));
            }
            Ok(ReauthenticationStep::Challenge { challenge })
        })
    }
    fn resume(&self, input: ResumeReauthentication) -> RemoteFuture<ReauthenticationStep> {
        let s = self.clone();
        Box::pin(async move {
            let state = s.state.lock().unwrap();
            if let Some(grant) = state.grants.get(&input.challenge_id) {
                return Ok(ReauthenticationStep::Granted { grant: grant.clone() });
            }
            let _input =
                state.pending.get(&input.challenge_id).ok_or_else(|| error(404, "reauthentication_not_found"))?;
            let mut challenge = state.challenges.get(&input.challenge_id).unwrap().clone();
            if !s.email_available.load(Ordering::SeqCst) {
                challenge.methods.retain(|m| !matches!(m, SecondFactor::Email));
            }
            Ok(ReauthenticationStep::Challenge { challenge })
        })
    }
    fn email_begin(&self, input: RequestFactorEmail) -> RemoteFuture<FactorEmailDelivery> {
        let s = self.clone();
        Box::pin(async move {
            if !s.email_available.load(Ordering::SeqCst) {
                return Err(Error::Protocol("unsupported_feature"));
            }
            assert!(s.memory.values.lock().unwrap().values().any(|raw| {
                serde_json::from_str::<serde_json::Value>(raw).unwrap()["email"]["input"]
                    == serde_json::to_value(&input).unwrap()
            }));
            assert!(!s.memory.values.lock().unwrap().values().any(|raw| raw.contains("PRIVATE-EMAIL-CODE")));
            s.mail_starts.fetch_add(1, Ordering::SeqCst);
            let mut state = s.state.lock().unwrap();
            let expires_at = state.challenges.get(&input.challenge_id).unwrap().expires_at.clone();
            state.deliveries.insert(input.delivery_id.clone(), input);
            if s.lose_mail.swap(false, Ordering::SeqCst) {
                return Err(Error::Protocol("connection_failed"));
            }
            Ok(FactorEmailDelivery { expires_at, delivery: EmailDeliveryState::Accepted, resend_after_seconds: 0 })
        })
    }
    fn email_resume(&self, input: RequestFactorEmail) -> RemoteFuture<FactorEmailDelivery> {
        let s = self.clone();
        Box::pin(async move {
            let state = s.state.lock().unwrap();
            let prior = state.deliveries.get(&input.delivery_id).ok_or_else(|| error(400, "factor_rejected"))?;
            if prior.operation_id != input.operation_id || prior.challenge_id != input.challenge_id {
                return Err(error(400, "factor_rejected"));
            }
            Ok(FactorEmailDelivery {
                expires_at: state.challenges.get(&input.challenge_id).unwrap().expires_at.clone(),
                delivery: EmailDeliveryState::Accepted,
                resend_after_seconds: 0,
            })
        })
    }
    fn finish(&self, input: FinishReauthentication) -> RemoteFuture<ReauthenticationGrant> {
        let s = self.clone();
        Box::pin(async move {
            s.finishes.fetch_add(1, Ordering::SeqCst);
            assert!(!s.memory.values.lock().unwrap().values().any(|raw| raw.contains("\"code\":")));
            let mut state = s.state.lock().unwrap();
            assert!(state.pending.contains_key(&input.challenge_id));
            state.head = "accepted".into();
            state.recent = true;
            let grant = ReauthenticationGrant {
                user_id: "alice".into(),
                device_id: "mobile".into(),
                instance_id: "instance".into(),
                data_epoch: "epoch".into(),
                factor_version: "factor".into(),
                proof_version: state.head.clone(),
                authenticated_at: chrono::Utc::now().to_rfc3339(),
                expires_at: (chrono::Utc::now() + chrono::Duration::minutes(15)).to_rfc3339(),
            };
            state.grants.insert(input.challenge_id, grant.clone());
            if s.lose_finish.swap(false, Ordering::SeqCst) {
                return Err(Error::Protocol("connection_failed"));
            }
            Ok(grant)
        })
    }
    fn retire(&self, input: RetireReauthentication) -> RemoteFuture<ReauthenticationStatus> {
        let s = self.clone();
        Box::pin(async move {
            let mut state = s.state.lock().unwrap();
            if state.head == input.proof_version {
                state.head = "retired".into();
                state.pending.clear();
            }
            drop(state);
            Ok(s.status_value())
        })
    }
    fn factor_status(&self) -> RemoteFuture<FactorStatus> {
        let s = self.clone();
        Box::pin(async move {
            let state = s.state.lock().unwrap();
            Ok(FactorStatus {
                totp: state.factor_version.is_some(),
                email: false,
                backup_codes_remaining: if state.factor_version.is_some() { 10 } else { 0 },
                factor_version: state.factor_version.clone(),
            })
        })
    }
    fn setup(&self, input: BeginFactorSetup) -> RemoteFuture<FactorSetup> {
        let s = self.clone();
        Box::pin(async move {
            assert!(s.has_operation(&input.operation_id));
            Ok(FactorSetup {
                setup_id: "setup-id".into(),
                secret: "PRIVATE-TOTP-SECRET".into(),
                provisioning_uri: "otpauth://totp/private".into(),
                expires_at: (chrono::Utc::now() + chrono::Duration::minutes(10)).to_rfc3339(),
            })
        })
    }
    fn enable(&self, input: EnableFactor) -> RemoteFuture<FactorBackupCodes> {
        let s = self.clone();
        Box::pin(async move {
            assert!(s.has_operation(&input.operation_id));
            if !input.code.is_empty() {
                assert!(!s.memory.values.lock().unwrap().values().any(|raw| raw.contains("\"code\":")));
            }
            let mut state = s.state.lock().unwrap();
            if let Some(bag) = state.bags.get(&input.operation_id) {
                return Ok(bag.clone());
            }
            let bag = Self::bag(&mut state, &input.operation_id);
            if s.change_enable.load(Ordering::SeqCst) {
                state.factor_version = Some("different-revision".into());
            }
            if let Some(guard) = s.cancel_enable.lock().unwrap().take() {
                guard.cancel();
            }
            if s.lose_enable.swap(false, Ordering::SeqCst) {
                return Err(Error::Protocol("connection_failed"));
            }
            Ok(bag)
        })
    }
    fn regenerate(&self, input: RegenerateFactorBackups) -> RemoteFuture<FactorBackupCodes> {
        let s = self.clone();
        Box::pin(async move {
            assert!(s.has_operation(&input.operation_id));
            let mut state = s.state.lock().unwrap();
            if let Some(bag) = state.bags.get(&input.operation_id) {
                return Ok(bag.clone());
            }
            assert_eq!(state.factor_version.as_deref(), Some(input.factor_version.as_str()));
            s.regenerations.fetch_add(1, Ordering::SeqCst);
            let bag = Self::bag(&mut state, &input.operation_id);
            if s.lose_regenerate.swap(false, Ordering::SeqCst) {
                return Err(Error::Protocol("connection_failed"));
            }
            Ok(bag)
        })
    }
    fn disable(&self, _input: DisableFactor) -> RemoteFuture<()> {
        let s = self.clone();
        Box::pin(async move {
            s.disables.fetch_add(1, Ordering::SeqCst);
            s.state.lock().unwrap().factor_version = None;
            if s.lose_disable.swap(false, Ordering::SeqCst) {
                return Err(Error::Protocol("connection_failed"));
            }
            Ok(())
        })
    }
}

#[test]
fn private_keys_pin_every_identity_field_and_canonicalize_url() {
    let key = scope().key().unwrap();
    assert!(key.starts_with("native-security-"));
    assert_eq!(key, Scope::new("https://EXAMPLE.org:443/", context()).unwrap().key().unwrap());
    for field in ["user_id", "device_id", "instance_id", "data_epoch"] {
        let mut value = serde_json::to_value(context()).unwrap();
        value[field] = json!("other");
        assert_ne!(
            key,
            Scope::new("https://example.org", serde_json::from_value(value).unwrap()).unwrap().key().unwrap()
        );
    }
    assert_ne!(key, Scope::new("https://other.org", context()).unwrap().key().unwrap());
    assert!(Scope::new("https://user:secret@example.org", context()).is_err());
}
#[tokio::test]
async fn lost_start_and_finish_ack_resume_after_recreation_without_password_or_second_code() {
    let temp = Temp::new();
    let memory = Arc::new(Memory::default());
    let server = Server::new(memory.clone());
    let vault = Vault::new(temp.0.clone(), memory.clone());
    let guard = Guard::new();
    server.lose_start.store(true, Ordering::SeqCst);
    assert_eq!(
        vault.prepare(&scope(), &server, "PRIVATE-PASSWORD", &guard).await.err().unwrap().code(),
        "connection_failed"
    );
    let ProofState::Challenge(saved) =
        Vault::new(temp.0.clone(), memory.clone()).prepare(&scope(), &server, "", &guard).await.unwrap()
    else {
        panic!("missing recovered challenge")
    };
    server.lose_finish.store(true, Ordering::SeqCst);
    assert_eq!(
        vault.finish(&saved, &server, SecondFactor::RecoveryCode, "PRIVATE-OTP", &guard).await.err().unwrap().code(),
        "connection_failed"
    );
    assert!(matches!(
        Vault::new(temp.0.clone(), memory.clone())
            .finish(&saved, &server, SecondFactor::Totp, "", &guard)
            .await
            .unwrap(),
        ProofState::Ready
    ));
    assert_eq!(server.starts.load(Ordering::SeqCst), 1);
    assert_eq!(server.finishes.load(Ordering::SeqCst), 1);
    assert!(memory.values.lock().unwrap().is_empty());
}
#[tokio::test]
async fn expired_pending_is_fenced_before_a_new_candidate_and_corruption_never_mutates() {
    let temp = Temp::new();
    let memory = Arc::new(Memory::default());
    let server = Server::new(memory.clone());
    let vault = Vault::new(temp.0.clone(), memory.clone());
    let guard = Guard::new();
    let ProofState::Challenge(first) = vault.prepare(&scope(), &server, "PRIVATE-PASSWORD", &guard).await.unwrap()
    else {
        panic!()
    };
    server.state.lock().unwrap().pending.clear();
    let ProofState::Challenge(second) = vault.prepare(&scope(), &server, "PRIVATE-PASSWORD", &guard).await.unwrap()
    else {
        panic!()
    };
    assert_ne!(first.challenge().unwrap().challenge_id, second.challenge().unwrap().challenge_id);
    assert_eq!(server.state.lock().unwrap().head, "retired");
    memory.values.lock().unwrap().insert(format!("{}-reauth", scope().key().unwrap()), "PRIVATE-CORRUPT".into());
    let err = vault.prepare(&scope(), &server, "PRIVATE-PASSWORD", &guard).await.err().unwrap();
    assert_eq!(err.code(), "invalid_native_security");
    assert!(!err.to_string().contains("PRIVATE-CORRUPT"));
    assert_eq!(server.starts.load(Ordering::SeqCst), 2);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn aborting_platform_write_keeps_the_os_lease_until_the_real_job_completes() {
    let temp = Temp::new();
    let memory = Arc::new(Memory::default());
    let server = Server::new(memory.clone());
    let block = Arc::new(Block::default());
    *memory.block.lock().unwrap() = Some(block.clone());
    let (config, store, remote) = (temp.0.clone(), memory.clone(), server.clone());
    let writing = tokio::spawn(async move {
        Vault::new(config, store).prepare(&scope(), &remote, "PRIVATE-PASSWORD", &Guard::new()).await
    });
    block.started.notified().await;
    writing.abort();
    let _ = writing.await;
    let lock =
        File::options().read(true).write(true).open(temp.0.join(format!("{}.lock", scope().key().unwrap()))).unwrap();
    assert!(matches!(lock.try_lock(), Err(std::fs::TryLockError::WouldBlock)));
    let waiting_guard = Guard::new();
    waiting_guard.cancel();
    assert_eq!(
        Vault::new(temp.0.clone(), memory.clone())
            .prepare(&scope(), &server, "", &waiting_guard)
            .await
            .err()
            .unwrap()
            .code(),
        "session_closed"
    );
    *memory.block.lock().unwrap() = None;
    *block.ready.lock().unwrap() = true;
    block.wake.notify_all();
    assert!(matches!(
        Vault::new(temp.0.clone(), memory.clone()).prepare(&scope(), &server, "", &Guard::new()).await.unwrap(),
        ProofState::Password
    ));
    assert_eq!(server.starts.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn unavailable_storage_never_dispatched_a_password_or_factor() {
    let temp = Temp::new();
    let memory = Arc::new(Memory::default());
    let server = Server::new(memory.clone());
    let vault = Vault::new(temp.0.clone(), memory.clone());
    memory.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        vault.prepare(&scope(), &server, "PRIVATE-PASSWORD", &Guard::new()).await.err().unwrap().code(),
        "secure_storage_unavailable"
    );
    assert_eq!(server.starts.load(Ordering::SeqCst), 0);
    assert_eq!(
        vault.factor_start(&scope(), &server, FactorAction::Setup, &Guard::new()).await.err().unwrap().code(),
        "secure_storage_unavailable"
    );
}
#[tokio::test]
async fn factor_receipts_recover_lost_enable_regenerate_and_disable_without_another_operation() {
    let temp = Temp::new();
    let memory = Arc::new(Memory::default());
    let server = Server::new(memory.clone());
    let vault = Vault::new(temp.0.clone(), memory.clone());
    let guard = Guard::new();
    let FactorState::Setup(setup) = vault.factor_start(&scope(), &server, FactorAction::Setup, &guard).await.unwrap()
    else {
        panic!()
    };
    server.lose_enable.store(true, Ordering::SeqCst);
    assert!(vault.factor_enable(&scope(), &server, &setup, "123456", &guard).await.is_err());
    let recreated = Vault::new(temp.0.clone(), memory.clone());
    let FactorState::Codes { receipt_id, codes } = recreated.factor_resume(&scope(), &server, &guard).await.unwrap()
    else {
        panic!()
    };
    assert_eq!(codes.codes.len(), 10);
    assert!(!vault.factor_clear(&scope(), "other", &guard).await.unwrap());
    assert!(vault.factor_clear(&scope(), &receipt_id, &guard).await.unwrap());
    server.lose_regenerate.store(true, Ordering::SeqCst);
    assert!(vault.factor_start(&scope(), &server, FactorAction::Regenerate, &guard).await.is_err());
    let FactorState::Codes { receipt_id, .. } = recreated.factor_resume(&scope(), &server, &guard).await.unwrap()
    else {
        panic!()
    };
    assert_eq!(server.regenerations.load(Ordering::SeqCst), 1);
    assert!(matches!(
        recreated.factor_start(&scope(), &server, FactorAction::Regenerate, &guard).await.unwrap(),
        FactorState::Codes { .. }
    ));
    assert_eq!(server.regenerations.load(Ordering::SeqCst), 1);
    vault.factor_clear(&scope(), &receipt_id, &guard).await.unwrap();
    server.lose_disable.store(true, Ordering::SeqCst);
    assert!(vault.factor_start(&scope(), &server, FactorAction::Disable, &guard).await.is_err());
    assert!(matches!(recreated.factor_resume(&scope(), &server, &guard).await.unwrap(), FactorState::Idle));
    assert_eq!(server.disables.load(Ordering::SeqCst), 1);
    assert!(memory.values.lock().unwrap().is_empty());
}
#[tokio::test]
async fn a_changed_revision_is_never_attached_to_old_codes_and_cancelled_views_keep_the_intent() {
    for changed in [true, false] {
        let temp = Temp::new();
        let memory = Arc::new(Memory::default());
        let server = Server::new(memory.clone());
        let vault = Vault::new(temp.0.clone(), memory.clone());
        let guard = Guard::new();
        let FactorState::Setup(setup) =
            vault.factor_start(&scope(), &server, FactorAction::Setup, &guard).await.unwrap()
        else {
            panic!()
        };
        if changed {
            server.change_enable.store(true, Ordering::SeqCst);
        } else {
            *server.cancel_enable.lock().unwrap() = Some(guard.clone());
        }
        let result = vault.factor_enable(&scope(), &server, &setup, "123456", &guard).await;
        if changed {
            assert!(matches!(result.unwrap(), FactorState::Stale { .. }));
        } else {
            assert_eq!(result.err().unwrap().code(), "session_closed");
            assert!(!memory.values.lock().unwrap().values().any(|raw| raw.contains("PRIVATE-BACKUP")));
            assert!(matches!(
                Vault::new(temp.0.clone(), memory.clone())
                    .factor_resume(&scope(), &server, &Guard::new())
                    .await
                    .unwrap(),
                FactorState::Codes { .. }
            ));
        }
    }
}
