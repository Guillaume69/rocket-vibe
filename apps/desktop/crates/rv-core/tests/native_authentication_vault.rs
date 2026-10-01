mod common;
use common::{FakeHttp, dropped, respond};
use rv_core::{
    native::{
        self,
        authentication::{LoginChallenge, PendingFactor, Step},
        authentication_vault::{self, Storage, StorageFuture, Vault},
    },
    session::SessionInfo,
};
use rv_protocol::parity::{AuthChallenge, SecondFactor};
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
        Self(std::env::temp_dir().join(format!("rv-auth-vault-{}-{}", std::process::id(), fastrand::u64(..))))
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
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap()
}
fn expiry() -> String {
    (chrono::Utc::now() + chrono::Duration::days(30)).to_rfc3339()
}
fn challenge(base: &str) -> LoginChallenge {
    let f = fixture();
    LoginChallenge {
        base_url: base.into(),
        identity: native::Identity {
            instance_id: f["discovery"]["instance_id"].as_str().unwrap().into(),
            data_epoch: f["discovery"]["data_epoch"].as_str().unwrap().into(),
        },
        user: serde_json::from_value(f["session"]["user"].clone()).unwrap(),
        pending: None,
        challenge: AuthChallenge {
            challenge_id: "a".repeat(64),
            methods: vec![SecondFactor::Totp, SecondFactor::RecoveryCode],
            expires_at: (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339(),
            resend_after_seconds: 0,
        },
    }
}
fn put(memory: &Memory, saved: &LoginChallenge) {
    memory.values.lock().unwrap().insert(
        authentication_vault::key(&saved.base_url, &saved.user.username).unwrap(),
        serde_json::to_string(saved).unwrap(),
    );
}
fn completed(saved: &LoginChallenge) -> SessionInfo {
    SessionInfo {
        base_url: saved.base_url.clone(),
        user_id: saved.user.id.clone(),
        username: saved.user.username.clone(),
        auth_token: saved.pending.as_ref().unwrap().next_token.clone(),
        native: Some(saved.identity.clone()),
    }
}
fn intent() -> PendingFactor {
    PendingFactor { operation_id: "b".repeat(64), next_token: "c".repeat(64) }
}
fn discovery() -> Value {
    let mut f = fixture()["discovery"].clone();
    f["capabilities"]["second_factors"] = json!(true);
    f["capabilities"]["device_sessions"] = json!(true);
    f
}

#[test]
fn keys_isolate_scopes_and_active_accounts_without_delimiter_ambiguity() {
    let key = authentication_vault::key("https://EXAMPLE.org:443/", "alice").unwrap();
    assert_eq!(key, authentication_vault::key("https://example.org", "alice").unwrap());
    assert!(key.starts_with("native-auth-"));
    assert!(key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
    assert_ne!(key, authentication_vault::key("https://other.org", "alice").unwrap());
    assert_ne!(key, authentication_vault::key("https://example.org", "bob").unwrap());
    assert_ne!(
        authentication_vault::key("https://example.org/a", "bc").unwrap(),
        authentication_vault::key("https://example.org/ab", "c").unwrap()
    );
    for bad in ["https://username:password@example.org", "https://example.org?key=secret", "file:///secret"] {
        assert!(authentication_vault::key(bad, "alice").is_err());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lost_ack_and_parallel_recreated_vaults_recover_one_session_without_another_code() {
    let temp = TempDir::new();
    let memory = Arc::new(Memory::default());
    let commits = Arc::new(Mutex::new(None::<String>));
    let calls = Arc::new(AtomicUsize::new(0));
    let (stored, accepted, count) = (memory.clone(), commits.clone(), calls.clone());
    let server=FakeHttp::start(move |request|match request.path(){
        "/.well-known/rocketvibe"=>respond(200,&discovery().to_string()),
        "/api/v1/auth/factors/verify"=>{
            count.fetch_add(1,Ordering::SeqCst);let input:Value=serde_json::from_str(&request.body).unwrap();
            let token=input["next_token"].as_str().unwrap().to_owned();
            assert!(stored.values.lock().unwrap().values().any(|raw|serde_json::from_str::<Value>(raw).unwrap()["pending"]["next_token"]==token));
            assert!(!stored.values.lock().unwrap().values().any(|raw|raw.contains("ONE-USE-BACKUP")));
            *accepted.lock().unwrap()=Some(token);dropped()
        },
        "/api/v1/me"=>if accepted.lock().unwrap().is_some(){respond(200,&fixture()["session"]["user"].to_string())}else{respond(401,&json!({"code":"session_rejected","request_id":"fixture"}).to_string())},
        "/api/v1/me/sessions"=>respond(200,&json!([{"id":"one-device","label":"Desktop","created_at":expiry(),"last_seen_at":expiry(),"expires_at":expiry(),"current":true}]).to_string()),
        _=>panic!("Unexpected route"),
    }).await;
    let vault = Vault::new(temp.0.clone(), memory.clone());
    let saved = challenge(server.url.as_str());
    vault.stage(saved.clone()).await.unwrap();
    assert!(vault.finish(&saved, SecondFactor::RecoveryCode, "ONE-USE-BACKUP").await.is_err());
    let mut durable = vault.load(&saved.base_url, &saved.user.username).await.unwrap().unwrap();
    assert!(durable.pending.is_some());
    durable.challenge.expires_at = (chrono::Utc::now() - chrono::Duration::days(1)).to_rfc3339();
    put(&memory, &durable);
    let first = Vault::new(temp.0.clone(), memory.clone());
    let second = Vault::new(temp.0.clone(), memory.clone());
    let (a, b) = tokio::join!(
        first.finish(&durable, SecondFactor::Totp, ""),
        second.finish(&durable, SecondFactor::RecoveryCode, "")
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.info.auth_token, b.info.auth_token);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(!vault.clear_completed(&saved, None).await.unwrap());
    assert!(vault.clear_completed(&saved, Some(&a.info)).await.unwrap());
    assert!(vault.load(&saved.base_url, &saved.user.username).await.unwrap().is_none());
    for file in std::fs::read_dir(&temp.0).unwrap() {
        let file = file.unwrap();
        assert_eq!(file.metadata().unwrap().len(), 0);
        assert!(file.file_name().to_string_lossy().starts_with("native-auth-"));
    }
}

#[tokio::test]
async fn pending_candidate_survives_fresh_proof_until_authoritative_expiry_barrier() {
    let server = FakeHttp::start(|request| match request.path() {
        "/.well-known/rocketvibe" => respond(200, &discovery().to_string()),
        "/api/v1/me" => respond(401, &json!({"code":"session_rejected","request_id":"fixture"}).to_string()),
        _ => panic!("Unexpected route"),
    })
    .await;
    let temp = TempDir::new();
    let memory = Arc::new(Memory::default());
    let vault = Vault::new(temp.0.clone(), memory.clone());
    let mut old = challenge(server.url.as_str());
    old.pending = Some(intent());
    put(&memory, &old);
    let mut fresh = challenge(server.url.as_str());
    fresh.challenge.challenge_id = "d".repeat(64);
    assert!(
        matches!(vault.stage(fresh.clone()).await.unwrap(),Step::Challenge(c) if c.challenge.challenge_id==old.challenge.challenge_id)
    );
    old.challenge.expires_at = (chrono::Utc::now() - chrono::Duration::minutes(1)).to_rfc3339();
    put(&memory, &old);
    assert!(
        matches!(vault.stage(fresh.clone()).await.unwrap(),Step::Challenge(c) if c.challenge.challenge_id==fresh.challenge.challenge_id)
    );
    assert_eq!(
        vault.load(&fresh.base_url, &fresh.user.username).await.unwrap().unwrap().challenge.challenge_id,
        fresh.challenge.challenge_id
    );
}

#[tokio::test]
async fn ambiguous_probe_or_changed_identity_never_overwrites_a_pending_record() {
    let server = FakeHttp::start(|request| match request.path() {
        "/.well-known/rocketvibe" => respond(200, &discovery().to_string()),
        "/api/v1/me" => respond(401, &json!({"message":"Proxy authentication"}).to_string()),
        _ => panic!("Unexpected route"),
    })
    .await;
    let temp = TempDir::new();
    let memory = Arc::new(Memory::default());
    let vault = Vault::new(temp.0.clone(), memory.clone());
    let mut old = challenge(server.url.as_str());
    old.pending = Some(intent());
    put(&memory, &old);
    let raw = memory.values.lock().unwrap().values().next().unwrap().clone();
    for identity_change in [false, true] {
        let mut fresh = challenge(server.url.as_str());
        if identity_change {
            fresh.identity.data_epoch = "restored".into();
        }
        assert!(vault.stage(fresh).await.is_err());
        assert_eq!(memory.values.lock().unwrap().values().next().unwrap(), &raw);
    }
}

#[tokio::test]
async fn corrupt_scope_and_stale_cleanup_fail_closed_without_exposing_raw_json() {
    let temp = TempDir::new();
    let memory = Arc::new(Memory::default());
    let vault = Vault::new(temp.0.clone(), memory.clone());
    let mut saved = challenge("https://example.org");
    saved.pending = Some(intent());
    let key = authentication_vault::key(&saved.base_url, &saved.user.username).unwrap();
    memory.values.lock().unwrap().insert(key.clone(), "{\"pending\":\"private-secret".into());
    assert_eq!(
        vault.load(&saved.base_url, &saved.user.username).await.err().unwrap().to_string(),
        "invalid_native_authentication"
    );
    let mut crossed = saved.clone();
    crossed.user.username = "other".into();
    memory.values.lock().unwrap().insert(key, serde_json::to_string(&crossed).unwrap());
    assert_eq!(
        vault.load(&saved.base_url, &saved.user.username).await.err().unwrap().code(),
        "invalid_native_authentication"
    );
    put(&memory, &saved);
    let active = completed(&saved);
    for field in ["token", "uid", "epoch", "url", "kind"] {
        let mut wrong = active.clone();
        match field {
            "token" => wrong.auth_token = "d".repeat(64),
            "uid" => wrong.user_id = "other".into(),
            "epoch" => wrong.native.as_mut().unwrap().data_epoch = "restored".into(),
            "url" => wrong.base_url = "https://other.org".into(),
            _ => wrong.native = None,
        };
        assert!(!vault.clear_completed(&saved, Some(&wrong)).await.unwrap());
    }
    let mut stale = saved.clone();
    stale.challenge.challenge_id = "e".repeat(64);
    assert!(!vault.clear_completed(&stale, Some(&active)).await.unwrap());
    assert!(vault.clear_completed(&saved, Some(&active)).await.unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelled_platform_write_retains_cross_instance_lease_until_actual_completion() {
    let temp = TempDir::new();
    let memory = Arc::new(Memory::default());
    let gate = Arc::new(Block::default());
    *memory.block.lock().unwrap() = Some(gate.clone());
    let first = Vault::new(temp.0.clone(), memory.clone());
    let old = challenge("https://example.org");
    let one = tokio::spawn(async move { first.stage(old).await });
    gate.started.notified().await;
    one.abort();
    match one.await {
        Err(error) => assert!(error.is_cancelled()),
        Ok(_) => panic!("Expected cancelled caller"),
    };
    let second = Vault::new(temp.0.clone(), memory.clone());
    let mut fresh = challenge("https://example.org");
    fresh.challenge.challenge_id = "d".repeat(64);
    let expected = fresh.clone();
    let mut two = tokio::spawn(async move { second.stage(fresh).await });
    assert!(tokio::time::timeout(std::time::Duration::from_millis(150), &mut two).await.is_err());
    *gate.ready.lock().unwrap() = true;
    gate.wake.notify_all();
    assert!(matches!(two.await.unwrap().unwrap(), Step::Challenge(_)));
    let loaded =
        Vault::new(temp.0.clone(), memory).load(&expected.base_url, &expected.user.username).await.unwrap().unwrap();
    assert_eq!(loaded.challenge.challenge_id, expected.challenge.challenge_id);
}

#[tokio::test]
async fn secure_write_failure_sends_no_code_and_releases_lease_for_later_stage() {
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let server = FakeHttp::start(move |request| {
        count.fetch_add(1, Ordering::SeqCst);
        assert_eq!(request.path(), "/.well-known/rocketvibe");
        respond(200, &discovery().to_string())
    })
    .await;
    let temp = TempDir::new();
    let memory = Arc::new(Memory::default());
    let vault = Vault::new(temp.0.clone(), memory.clone());
    let saved = challenge(server.url.as_str());
    vault.stage(saved.clone()).await.unwrap();
    memory.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        vault.finish(&saved, SecondFactor::Totp, "123456").await.err().unwrap().code(),
        "secure_storage_unavailable"
    );
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert!(vault.load(&saved.base_url, &saved.user.username).await.unwrap().unwrap().pending.is_none());
    memory.fail.store(false, Ordering::SeqCst);
    assert!(matches!(vault.stage(saved).await.unwrap(), Step::Challenge(_)));
}
