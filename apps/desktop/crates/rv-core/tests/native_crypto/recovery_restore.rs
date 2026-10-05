use super::*;
#[tokio::test]
async fn fresh_http_device_recovers_root_then_enrolls_a_new_leaf_without_cross_view_confirmation() {
    let pilot = Pilot::new(true).await;
    let controller = ready(&pilot).await;
    let backups = Backups::attach(&pilot);
    let preview = controller.preview_backup().await.unwrap();
    controller.prepare_backup(preview).await.unwrap();
    let code = controller.backup_code().await.unwrap();
    assert!(controller.confirm_backup_code().await.is_err());
    controller.resume_backup().await.unwrap();
    let original_directory = pilot.crypto_directory.lock().unwrap().clone();
    let old = original_directory["devices"][0].clone();
    let fingerprint = original_directory["identity"]["fingerprint"].as_str().unwrap().to_owned();
    let scope = original_directory["scope"].clone();
    let backups2 = backups.clone();
    *pilot.room_handler.lock().unwrap() = Some(Arc::new(move |r| {
        if r.path() == "/api/v1/me/sessions" {
            Some(respond(200,&json!([{"id":"recovered","label":"New device","created_at":"0","last_seen_at":"0","expires_at":"0","current":true}]).to_string()))
        } else {
            backups2.reply(r, &scope)
        }
    }));
    let fresh = pilot
        .session
        .crypto_settings(Guard::new(), pilot.directory.path().join("fresh-recovery"), pilot.memory.clone())
        .await
        .unwrap();
    let separate = pilot
        .session
        .crypto_settings(Guard::new(), pilot.directory.path().join("fresh-recovery"), pilot.memory.clone())
        .await
        .unwrap();
    let wrong = rv_crypto::identity::recovery::RecoverySecret::generate().unwrap().for_display();
    assert!(fresh.preview_restore(wrong, fingerprint.clone()).await.is_err());
    assert!(fresh.refresh().await.unwrap().stage == crypto::enrollment::Stage::Missing);
    let preview = fresh.preview_restore(Zeroizing::new(code.to_string()), fingerprint.clone()).await.unwrap();
    assert!(separate.restore_root(preview).await.is_err());
    assert!(fresh.refresh().await.unwrap().stage == crypto::enrollment::Stage::Missing);
    let preview = fresh.preview_restore(Zeroizing::new(code.to_string()), fingerprint.clone()).await.unwrap();
    let restored = fresh.restore_root(preview).await.unwrap();
    assert!(restored.controls_root && restored.stage == crypto::enrollment::Stage::IdentityCreated);
    assert_eq!(restored.root_fingerprint, fingerprint);
    let preview = fresh.preview(restored.request_code).await.unwrap();
    let grant = fresh.approve(preview).await.unwrap();
    let enrolled = fresh.install(grant).await.unwrap();
    assert!(enrolled.stage == crypto::enrollment::Stage::Ready);
    let new = pilot.crypto_directory.lock().unwrap()["devices"][0].clone();
    assert_eq!(new["device_id"], "recovered");
    assert_ne!(old["incarnation"], new["incarnation"]);
    assert_ne!(old["certificate"], new["certificate"]);
    assert_eq!(backups.posts.load(Ordering::SeqCst), 1);
    fresh.close();
    separate.close();
    controller.close();
    pilot.close().await;
}
