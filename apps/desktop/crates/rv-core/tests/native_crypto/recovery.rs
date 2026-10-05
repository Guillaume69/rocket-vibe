use super::*;
use rv_crypto_public::recovery::Publication;
#[path = "recovery_restore.rs"]
mod recovery_restore;
struct Backups {
    active: Mutex<Option<Value>>,
    receipt: Mutex<Option<Value>>,
    cancellation: Mutex<Option<Value>>,
    posts: AtomicUsize,
    cancels: AtomicUsize,
    fail_read: AtomicBool,
}
impl Backups {
    fn attach(pilot: &Pilot) -> Arc<Self> {
        let state = Arc::new(Self {
            active: Mutex::new(None),
            receipt: Mutex::new(None),
            cancellation: Mutex::new(None),
            posts: AtomicUsize::new(0),
            cancels: AtomicUsize::new(0),
            fail_read: AtomicBool::new(false),
        });
        let state2 = state.clone();
        let scope = pilot.crypto_directory.lock().unwrap()["scope"].clone();
        *pilot.room_handler.lock().unwrap() = Some(Arc::new(move |r| state2.reply(r, &scope)));
        state
    }
    fn reply(&self, r: &common::Request, scope: &Value) -> Option<common::Response> {
        let path = r.path();
        if !path.starts_with("/api/v1/e2ee/root-backup") {
            return None;
        }
        assert_eq!(r.headers["authorization"], "Bearer fixture-token");
        if path == "/api/v1/e2ee/root-backup" && r.method == "GET" {
            return Some(respond(
                200,
                &json!({"scope":scope,"active":self.active.lock().unwrap().clone()}).to_string(),
            ));
        }
        if path.ends_with("/cancel") {
            self.cancels.fetch_add(1, Ordering::SeqCst);
            let input: rv_protocol::e2ee::PublishRootBackup = serde_json::from_str(&r.body).unwrap();
            let p = Publication::from_bytes(&B64.decode(&input.publication).unwrap()).unwrap();
            let result = if let Some(receipt) = self.receipt.lock().unwrap().clone() {
                json!({"kind":"accepted","data":receipt})
            } else {
                let metadata = json!({"scope":input.scope,"operation_id":input.operation_id,"device_id":p.body.device,"incarnation":hex(&p.body.incarnation),"device_revision":p.body.device_revision,"root_fingerprint":hex(&p.packet.header.root.fingerprint().unwrap()),"backup_id":hex(&p.packet.header.backup_id),"packet_digest":hex(&p.body.packet_digest),"expected_revision":p.body.expected_revision});
                json!({"kind":"cancelled","data":metadata})
            };
            *self.cancellation.lock().unwrap() = Some(result.clone());
            return Some(if self.cancels.load(Ordering::SeqCst) == 1 {
                respond(503, r#"{"code":"response_lost","request_id":"backup-pilot"}"#)
            } else {
                respond(200, &result.to_string())
            });
        }
        if path.starts_with("/api/v1/e2ee/root-backup/operations/") {
            if self.fail_read.load(Ordering::SeqCst) {
                return Some(respond(503, r#"{"code":"unavailable","request_id":"backup-pilot"}"#));
            }
            return Some(if let Some(receipt) = self.receipt.lock().unwrap().as_ref() {
                respond(200, &receipt.to_string())
            } else {
                respond(404, r#"{"code":"not_found","request_id":"backup-pilot"}"#)
            });
        }
        assert_eq!(r.method, "POST");
        self.posts.fetch_add(1, Ordering::SeqCst);
        let input: rv_protocol::e2ee::PublishRootBackup = serde_json::from_str(&r.body).unwrap();
        let p = Publication::from_bytes(&B64.decode(&input.publication).unwrap()).unwrap();
        let receipt = json!({"scope":input.scope,"operation_id":input.operation_id,"device_id":p.body.device,"incarnation":hex(&p.body.incarnation),"device_revision":p.body.device_revision,"root_fingerprint":hex(&p.packet.header.root.fingerprint().unwrap()),"backup_id":hex(&p.packet.header.backup_id),"backup_revision":"1","packet_digest":hex(&p.body.packet_digest)});
        *self.active.lock().unwrap() = Some(json!({"publication":input.publication,"receipt":receipt}));
        *self.receipt.lock().unwrap() = Some(receipt);
        Some(respond(503, r#"{"code":"response_lost","request_id":"backup-pilot"}"#))
    }
}
#[tokio::test]
async fn backup_lost_reply_reopens_original_by_get_and_other_view_cannot_confirm() {
    let pilot = Pilot::new(true).await;
    let access = ready(&pilot).await;
    let server = Backups::attach(&pilot);
    let separate = pilot
        .session
        .crypto_settings(Guard::new(), pilot.directory.path().join("ceremony"), pilot.memory.clone())
        .await
        .unwrap();
    let preview = access.preview_backup().await.unwrap();
    assert!(separate.prepare_backup(preview).await.is_err());
    let preview = access.preview_backup().await.unwrap();
    let status = access.prepare_backup(preview).await.unwrap();
    assert!(status.pending && !status.code_saved);
    assert_eq!(server.posts.load(Ordering::SeqCst), 0);
    let code = access.backup_code().await.unwrap();
    assert_eq!(code.len(), 78);
    assert!(access.confirm_backup_code().await.is_err());
    assert_eq!(server.posts.load(Ordering::SeqCst), 1);
    let r = pilot
        .server
        .requests()
        .into_iter()
        .find(|r| r.path() == "/api/v1/e2ee/root-backup" && r.method == "POST")
        .unwrap();
    assert!(!r.body.contains(code.as_str()));
    assert_eq!(access.backup_code().await.unwrap().as_str(), code.as_str());
    access.close();
    let reopened = pilot
        .session
        .crypto_settings(Guard::new(), pilot.directory.path().join("ceremony"), pilot.memory.clone())
        .await
        .unwrap();
    let status = reopened.resume_backup().await.unwrap();
    assert!(!status.pending);
    assert_eq!(status.receipt.unwrap().backup_revision, "1");
    assert_eq!(server.posts.load(Ordering::SeqCst), 1);
    assert!(reopened.backup_code().await.is_err());
    reopened.close();
    separate.close();
    pilot.close().await;
}
#[tokio::test]
async fn unavailable_receipt_never_posts_and_abandonment_reopens_only_its_original_terminal_request() {
    let pilot = Pilot::new(true).await;
    let access = ready(&pilot).await;
    let server = Backups::attach(&pilot);
    let preview = access.preview_backup().await.unwrap();
    access.prepare_backup(preview).await.unwrap();
    server.fail_read.store(true, Ordering::SeqCst);
    assert!(access.confirm_backup_code().await.is_err());
    assert_eq!(server.posts.load(Ordering::SeqCst), 0);
    assert!(access.cancel_backup().await.is_err());
    assert_eq!(server.cancels.load(Ordering::SeqCst), 1);
    assert!(access.backup_status().await.unwrap().cancel_requested);
    access.close();
    let reopened = pilot
        .session
        .crypto_settings(Guard::new(), pilot.directory.path().join("ceremony"), pilot.memory.clone())
        .await
        .unwrap();
    let status = reopened.resume_backup().await.unwrap();
    assert!(!status.pending && status.receipt.is_none());
    assert_eq!(server.posts.load(Ordering::SeqCst), 0);
    assert_eq!(server.cancels.load(Ordering::SeqCst), 2);
    let requests = pilot.server.requests();
    let cancels: Vec<_> = requests.iter().filter(|r| r.path().ends_with("/cancel")).collect();
    assert_eq!(cancels[0].body, cancels[1].body);
    reopened.close();
    pilot.close().await;
}
#[tokio::test]
async fn close_during_backup_checkpoint_hides_code_and_keeps_pending_packet_without_http() {
    let pilot = Pilot::new(true).await;
    let access = ready(&pilot).await;
    let server = Backups::attach(&pilot);
    let preview = access.preview_backup().await.unwrap();
    let gate = Arc::new(Gate::default());
    *pilot.memory.blocked_write.lock().unwrap() = Some(gate.clone());
    let task = tokio::spawn({
        let access = access.clone();
        async move { access.prepare_backup(preview).await }
    });
    gate.entered().await;
    access.close();
    gate.release();
    assert!(task.await.unwrap().is_err());
    assert_eq!(server.posts.load(Ordering::SeqCst), 0);
    assert!(access.backup_code().await.is_err());
    let reopened = pilot
        .session
        .crypto_settings(Guard::new(), pilot.directory.path().join("ceremony"), pilot.memory.clone())
        .await
        .unwrap();
    let status = reopened.backup_status().await.unwrap();
    assert!(status.pending && !status.code_saved);
    assert_eq!(reopened.backup_code().await.unwrap().len(), 78);
    reopened.close();
    pilot.close().await;
}
