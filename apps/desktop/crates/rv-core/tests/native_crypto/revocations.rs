use super::*;
use rv_crypto::identity::Revocation;

#[tokio::test]
async fn closed_view_during_withdrawal_checkpoint_keeps_original_outbox_without_sending() {
    let pilot = Pilot::new(true).await;
    let (access, installation, certificate) = target_fixture(&pilot).await;
    let preview = access.preview_withdrawal("other".into(), hex(&certificate.fingerprint().unwrap())).await.unwrap();
    let gate = Arc::new(Gate::default());
    *pilot.memory.blocked_write.lock().unwrap() = Some(gate.clone());
    let delayed = tokio::spawn({
        let access = access.clone();
        async move { access.withdraw_device(preview).await }
    });
    gate.entered().await;
    access.close();
    gate.release();
    assert_eq!(session_code(delayed.await.unwrap().err().unwrap()), "session_closed");
    assert!(!pilot.server.requests().iter().any(|r| r.path() == "/api/v1/e2ee/revocations"));
    let c = rv_crypto::account::Coordinator::new(&installation);
    let original = c.pending_withdrawal().unwrap();
    let proof: Revocation = serde_json::from_slice(&B64.decode(&original.signed).unwrap()).unwrap();
    proof.verify().unwrap();
    assert_eq!(proof.incarnation, certificate.device.incarnation);
    let reopened = pilot
        .session
        .crypto_settings(Guard::new(), pilot.directory.path().join("ceremony"), pilot.memory.clone())
        .await
        .unwrap();
    assert_eq!(reopened.withdrawals().await.unwrap().pending.unwrap().device, "other");
    assert_eq!(serde_json::to_vec(&c.pending_withdrawal().unwrap()).unwrap(), serde_json::to_vec(&original).unwrap());
    reopened.close();
    pilot.close().await;
}

async fn target_fixture(
    pilot: &Pilot,
) -> (crypto::enrollment::Access, rv_crypto::installation::Installation, rv_crypto::identity::Certificate) {
    online(&pilot.session).await;
    let access = ready(pilot).await;
    let conversation = access.conversation().await.unwrap();
    let installation = rv_crypto::installation::Installation::new(
        pilot.directory.path().join("ceremony"),
        rv_crypto::installation::Account {
            origin: pilot.session.info.base_url.clone(),
            instance: conversation.scope().instance.clone(),
            data_epoch: conversation.scope().data_epoch.clone(),
            user: conversation.scope().user.clone(),
            device: conversation.scope().device.clone(),
        },
        pilot.memory.clone(),
    )
    .unwrap();
    let manager = installation.load().unwrap().unwrap();
    let certificate = manager
        .inspect(|_, records| {
            let issuer = Issuer::load(records, "fixture-instance", &pilot.session.info.user_id).unwrap();
            let mut target = vault::Records::new();
            let mut local = LocalDevice::create_bound(issuer.root(), "other", [18; 16], &mut target).unwrap();
            let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
            let request = local.request(now, &mut target).unwrap();
            let preview = issuer.preview_request(&request, now, 3600, &target).unwrap();
            let grant = issuer.approve_request(&request, &preview, now, &mut target).unwrap();
            local.install(&grant, now, &mut target).unwrap();
            Ok(grant.certificate)
        })
        .unwrap();
    pilot.crypto_directory.lock().unwrap()["devices"].as_array_mut().unwrap().push(json!({
        "device_id":"other", "incarnation":hex(&certificate.device.incarnation),
        "certificate":B64.encode(serde_json::to_vec(&certificate).unwrap()),
        "revision":"1", "expires_at":certificate.device.expires_at.to_string()
    }));
    (access, installation, certificate)
}

#[tokio::test]
async fn signed_withdrawal_lost_response_reopens_without_second_post_and_old_view_cannot_confirm() {
    let pilot = Pilot::new(true).await;
    let (access, _installation, certificate) = target_fixture(&pilot).await;
    let status = access.withdrawals().await.unwrap();
    assert_eq!(status.devices.len(), 1);
    let fp = status.devices[0].fingerprint.clone();
    let posts = Arc::new(Mutex::new(Vec::<String>::new()));
    let original_posts = posts.clone();
    let accepted = Arc::new(Mutex::new(None::<Value>));
    let receipt_reply = accepted.clone();
    let directory_reply = pilot.crypto_directory.clone();
    let controller = pilot.crypto_directory.lock().unwrap()["devices"][0].clone();
    let root = certificate.device.root.clone();
    *pilot.room_handler.lock().unwrap() = Some(Arc::new(move |request| {
        if request.path() == "/api/v1/e2ee/revocations" {
            assert_eq!(request.headers["authorization"], "Bearer fixture-token");
            original_posts.lock().unwrap().push(request.body.clone());
            let input: rv_protocol::e2ee::RevokeDevice = serde_json::from_str(&request.body).unwrap();
            let proof: Revocation = serde_json::from_slice(&B64.decode(&input.signed).unwrap()).unwrap();
            proof.verify().unwrap();
            assert_eq!(proof.root, root);
            assert_eq!(proof.device, "other");
            assert_eq!(proof.incarnation, [18; 16]);
            assert_eq!(input.incarnation, controller["incarnation"]);
            assert_eq!(input.device_revision, "1");
            *receipt_reply.lock().unwrap() = Some(
                json!({"scope": input.scope, "operation_id":input.operation_id, "kind":"revoke_device", "device_id":"current",
                "incarnation":input.incarnation, "device_revision":input.device_revision, "root_fingerprint":hex(&root.fingerprint().unwrap()), "key_package_refs":[]}),
            );
            let mut directory = directory_reply.lock().unwrap();
            directory["devices"].as_array_mut().unwrap().retain(|d| d["device_id"] != "other");
            directory["revocations"] = json!([{"position":"1","signed":input.signed}]);
            Some(respond(503, r#"{"code":"response_lost","request_id":"crypto-withdrawal"}"#))
        } else if request.path().starts_with("/api/v1/e2ee/operations/") {
            receipt_reply
                .lock()
                .unwrap()
                .as_ref()
                .filter(|r| r["operation_id"].as_str() == request.path().rsplit('/').next())
                .map(|r| respond(200, &r.to_string()))
        } else {
            None
        }
    }));
    let preview = access.preview_withdrawal("other".into(), fp.clone()).await.unwrap();
    assert_eq!(preview.fingerprint, fp);
    assert!(posts.lock().unwrap().is_empty());
    let separate = pilot
        .session
        .crypto_settings(Guard::new(), pilot.directory.path().join("ceremony"), pilot.memory.clone())
        .await
        .unwrap();
    assert!(separate.withdraw_device(preview).await.is_err());
    assert!(posts.lock().unwrap().is_empty());
    let preview = access.preview_withdrawal("other".into(), fp).await.unwrap();
    assert!(access.withdraw_device(preview).await.is_err());
    assert_eq!(posts.lock().unwrap().len(), 1);
    let staged = access.withdrawals().await.unwrap();
    assert_eq!(staged.pending.unwrap().device, "other");
    assert!(staged.devices.is_empty());
    access.close();
    assert!(access.resume_withdrawal().await.is_err());
    let reopened = pilot
        .session
        .crypto_settings(Guard::new(), pilot.directory.path().join("ceremony"), pilot.memory.clone())
        .await
        .unwrap();
    let resumed = reopened.resume_withdrawal().await.unwrap();
    assert!(resumed.pending.is_none());
    assert_eq!(resumed.withdrawn.len(), 1);
    assert_eq!(posts.lock().unwrap().len(), 1);
    assert_eq!(pilot.registrations.lock().unwrap().len(), 1);
    // Even an omitted server proof never restores the target locally.
    pilot.crypto_directory.lock().unwrap()["revocations"] = json!([]);
    assert_eq!(reopened.withdrawals().await.unwrap().withdrawn.len(), 1);
    reopened.close();
    separate.close();
    pilot.close().await;
}
