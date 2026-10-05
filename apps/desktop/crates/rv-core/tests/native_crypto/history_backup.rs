use super::*;
use rv_crypto_public::history_backup::Publication;

/// History backup routes of one account: one active key, no period yet.
struct Keys {
    scope: Value,
    active: Mutex<Option<Value>>,
    receipt: Mutex<Option<Value>>,
    posts: AtomicUsize,
}
impl Keys {
    fn attach(pilot: &Pilot) -> Arc<Self> {
        let scope = pilot.crypto_directory.lock().unwrap()["scope"].clone();
        let state =
            Arc::new(Self { scope, active: Mutex::new(None), receipt: Mutex::new(None), posts: AtomicUsize::new(0) });
        let state2 = state.clone();
        *pilot.room_handler.lock().unwrap() = Some(Arc::new(move |r| state2.reply(r)));
        state
    }
    fn reply(&self, r: &common::Request) -> Option<common::Response> {
        let path = r.path();
        if !path.starts_with("/api/v1/e2ee/history-backup") {
            return None;
        }
        assert_eq!(r.headers["authorization"], "Bearer fixture-token");
        if path == "/api/v1/e2ee/history-backup" && r.method == "GET" {
            return Some(respond(
                200,
                &json!({"scope":self.scope,"active":self.active.lock().unwrap().clone()}).to_string(),
            ));
        }
        if path.starts_with("/api/v1/e2ee/history-backup/operations/") {
            return Some(match self.receipt.lock().unwrap().as_ref() {
                Some(receipt) => respond(200, &receipt.to_string()),
                None => respond(404, r#"{"code":"not_found","request_id":"backup-pilot"}"#),
            });
        }
        if path == "/api/v1/e2ee/history-backup/periods" {
            return Some(respond(
                200,
                &json!({"scope":self.scope,"generation":"00","periods":[],"next":null}).to_string(),
            ));
        }
        assert_eq!((path, r.method.as_str()), ("/api/v1/e2ee/history-backup", "POST"));
        self.posts.fetch_add(1, Ordering::SeqCst);
        let input: rv_protocol::e2ee::PublishHistoryKey = serde_json::from_str(&r.body).unwrap();
        let p = Publication::from_bytes(&B64.decode(&input.publication).unwrap()).unwrap();
        let receipt = json!({"scope":input.scope,"operation_id":input.operation_id,"device_id":p.body.device,
            "incarnation":hex(&p.body.incarnation),"device_revision":p.body.device_revision,
            "root_fingerprint":hex(&p.package.header.root.fingerprint().unwrap()),
            "generation":hex(&p.package.header.generation),"generation_revision":"1",
            "package_digest":hex(&p.body.package_digest)});
        *self.active.lock().unwrap() = Some(json!({"publication":input.publication,"receipt":receipt}));
        *self.receipt.lock().unwrap() = Some(receipt);
        // The response is lost; the receipt is found again by its operation.
        Some(respond(503, r#"{"code":"response_lost","request_id":"backup-pilot"}"#))
    }
}

#[tokio::test]
async fn enabling_publishes_once_after_the_code_is_saved_and_the_code_joins_the_generation() {
    let pilot = Pilot::new(true).await;
    let access = ready(&pilot).await;
    let server = Keys::attach(&pilot);
    assert!(!access.history_backup_status().await.unwrap().holds_key);
    let approval = access.preview_history_backup().await.unwrap();
    assert_eq!(approval.generation_revision, None);
    let status = access.prepare_history_backup(approval).await.unwrap();
    assert!(status.pending && !status.code_saved);
    let code = access.history_backup_code().await.unwrap();
    assert!(code.starts_with("rvh1-"));
    assert_eq!(server.posts.load(Ordering::SeqCst), 0);
    // The publication's response is lost; resuming finds its receipt by GET.
    assert!(access.confirm_history_backup_code().await.is_err());
    assert_eq!(server.posts.load(Ordering::SeqCst), 1);
    let status = access.resume_history_backup().await.unwrap();
    assert!(status.holds_key && !status.pending);
    assert_eq!(server.posts.load(Ordering::SeqCst), 1);
    for request in pilot.server.requests() {
        assert!(!request.body.contains(code.as_str()));
    }
    // Nothing observed yet: nothing to upload or restore.
    assert_eq!(access.sync_history_backup().await.unwrap(), 0);
    assert_eq!(access.restore_history_backup().await.unwrap(), 0);
    // The code joins the active generation; another code does not.
    assert!(
        access.join_history_backup(Zeroizing::new("rvh1-".to_owned() + &"00".repeat(32) + "-00000000")).await.is_err()
    );
    let joined = access.join_history_backup(code).await.unwrap();
    assert_eq!(joined.generation, status.generation);
    access.close();
    pilot.close().await;
}
