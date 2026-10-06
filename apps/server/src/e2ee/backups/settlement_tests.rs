use super::*;
fn cancelled_metadata(result: wire::RootBackupSettlement) -> wire::RootBackupCancellation {
    match result {
        wire::RootBackupSettlement::Cancelled(receipt) => receipt,
        _ => panic!("expected cancellation"),
    }
}
#[sqlx::test]
async fn cancelled_backup_cannot_publish_after_reopen_and_quota_never_hides_terminal_result(
    pool: PgPool,
) {
    let (app, owner, _, keys) = enrolled(pool).await;
    let original = request(&keys, None);
    let (left, right) = tokio::join!(
        backups::cancel(&app, &owner, &original.operation_id, original.clone()),
        backups::cancel(&app, &owner, &original.operation_id, original.clone())
    );
    assert_eq!(
        serde_json::to_value(left.unwrap()).unwrap(),
        serde_json::to_value(right.unwrap()).unwrap()
    );
    let receipt = cancelled_metadata(
        backups::cancel(&app, &owner, &original.operation_id, original.clone())
            .await
            .unwrap(),
    );
    assert_eq!(receipt.operation_id, original.operation_id);
    assert_eq!(receipt.device_id, keys.certificate.device.device);
    assert_eq!(receipt.expected_revision, None);
    assert!(
        backups::current(&app, &owner)
            .await
            .unwrap()
            .active
            .is_none()
    );
    let restarted = App::from_pool(app.pool.clone()).await.unwrap();
    assert_eq!(
        backups::publish(&restarted, &owner, original.clone())
            .await
            .err()
            .unwrap()
            .code,
        "crypto_backup_cancelled"
    );
    assert_eq!(
        backups::operation(&restarted, &owner, &original.operation_id)
            .await
            .err()
            .unwrap()
            .code,
        "crypto_backup_cancelled"
    );
    sqlx::query("INSERT INTO e2ee_root_backup_cancellations(user_id,device_id,operation_id,fingerprint,receipt) SELECT $1,$2,'quota-'||n,'fixture',$3 FROM generate_series(1,63) n")
        .bind(&owner.id).bind(&receipt.device_id).bind(serde_json::to_value(&receipt).unwrap()).execute(&app.pool).await.unwrap();
    let result = backups::cancel(&app, &owner, &original.operation_id, original.clone())
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(cancelled_metadata(result)).unwrap(),
        serde_json::to_value(receipt).unwrap()
    );
    let fresh = request(&keys, None);
    assert_eq!(
        backups::cancel(&app, &owner, &fresh.operation_id, fresh.clone())
            .await
            .err()
            .unwrap()
            .code,
        "crypto_backup_cancellation_limit"
    );
    let substituted = mutate(&original, &keys, |p| {
        p.packet.nonce[0] ^= 1;
        p.body.packet_digest = p.packet.digest().unwrap();
    });
    assert_eq!(
        backups::cancel(&app, &owner, &original.operation_id, substituted)
            .await
            .err()
            .unwrap()
            .code,
        "operation_conflict"
    );
    sqlx::query("UPDATE instance SET data_epoch=$1 WHERE singleton")
        .bind(auth::random_token())
        .execute(&app.pool)
        .await
        .unwrap();
    assert_eq!(
        backups::operation(&app, &owner, &original.operation_id)
            .await
            .err()
            .unwrap()
            .code,
        "data_epoch_changed"
    );
}
#[sqlx::test]
async fn competing_publish_and_cancel_have_one_terminal_result_and_keep_any_accepted_version(
    pool: PgPool,
) {
    let (app, owner, _, keys) = enrolled(pool).await;
    let original = request(&keys, None);
    let (published, settled) = tokio::join!(
        backups::publish(&app, &owner, original.clone()),
        backups::cancel(&app, &owner, &original.operation_id, original.clone())
    );
    match settled.unwrap() {
        wire::RootBackupSettlement::Accepted(receipt) => {
            equal(&published.unwrap(), &receipt);
            equal(
                &backups::current(&app, &owner)
                    .await
                    .unwrap()
                    .active
                    .unwrap()
                    .receipt,
                &receipt,
            );
            let cancelled: i64 =
                sqlx::query_scalar("SELECT count(*) FROM e2ee_root_backup_cancellations")
                    .fetch_one(&app.pool)
                    .await
                    .unwrap();
            assert_eq!(cancelled, 0);
        }
        wire::RootBackupSettlement::Cancelled(receipt) => {
            assert_eq!(published.err().unwrap().code, "crypto_backup_cancelled");
            assert_eq!(receipt.operation_id, original.operation_id);
            assert!(
                backups::current(&app, &owner)
                    .await
                    .unwrap()
                    .active
                    .is_none()
            );
            let accepted: i64 =
                sqlx::query_scalar("SELECT count(*) FROM e2ee_root_backup_operations")
                    .fetch_one(&app.pool)
                    .await
                    .unwrap();
            assert_eq!(accepted, 0);
        }
    }
    // Abandonment of an older accepted version returns its original result,
    // even when the active version has since been replaced.
    let previous = backups::current(&app, &owner)
        .await
        .unwrap()
        .active
        .map(|p| p.receipt.backup_revision);
    let first = request(&keys, previous.as_deref());
    let receipt = backups::publish(&app, &owner, first.clone()).await.unwrap();
    let second = request(&keys, Some(&receipt.backup_revision));
    let next = backups::publish(&app, &owner, second.clone())
        .await
        .unwrap();
    sqlx::query(
        "UPDATE session_devices SET created_at=clock_timestamp()-interval '1 day' WHERE id=$1",
    )
    .bind(&receipt.device_id)
    .execute(&app.pool)
    .await
    .unwrap();
    let wire::RootBackupSettlement::Accepted(saved) =
        backups::cancel(&app, &owner, &first.operation_id, first.clone())
            .await
            .unwrap()
    else {
        panic!("accepted original was erased")
    };
    equal(&saved, &receipt);
    equal(
        &backups::current(&app, &owner)
            .await
            .unwrap()
            .active
            .unwrap()
            .receipt,
        &next,
    );
}
#[sqlx::test]
async fn conflict_abandonment_allows_next_backup_but_rejects_other_account_device_and_unowned_root(
    pool: PgPool,
) {
    let (app, owner, _, keys) = enrolled(pool).await;
    let conflict = request(&keys, None);
    let accepted = request(&keys, None);
    backups::publish(&app, &owner, accepted).await.unwrap();
    assert_eq!(
        backups::publish(&app, &owner, conflict.clone())
            .await
            .err()
            .unwrap()
            .code,
        "backup_revision_conflict"
    );
    let (other_device, _) = login(&app, "backup-owner").await;
    assert!(
        backups::cancel(
            &app,
            &other_device,
            &conflict.operation_id,
            conflict.clone()
        )
        .await
        .is_err()
    );
    let (other_account, _) = actor(&app, "backup-other-user").await;
    assert!(
        backups::cancel(
            &app,
            &other_account,
            &conflict.operation_id,
            conflict.clone()
        )
        .await
        .is_err()
    );
    let foreign_keys = client(&app, &owner, None).await;
    let wrong_root = request(&foreign_keys, None);
    assert_eq!(
        backups::cancel(&app, &owner, &wrong_root.operation_id, wrong_root.clone())
            .await
            .err()
            .unwrap()
            .code,
        "crypto_identity_changed"
    );
    assert!(
        backups::cancel(&app, &owner, "substituted-id", conflict.clone())
            .await
            .is_err()
    );
    cancelled_metadata(
        backups::cancel(&app, &owner, &conflict.operation_id, conflict.clone())
            .await
            .unwrap(),
    );
    let next = request(&keys, Some("1"));
    assert_eq!(
        backups::publish(&app, &owner, next)
            .await
            .unwrap()
            .backup_revision,
        "2"
    );
}
#[sqlx::test]
async fn lost_cancellation_http_body_replays_original_to_one_terminal_decision(pool: PgPool) {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let (app, owner, token, keys) = enrolled(pool).await;
    let posts = Arc::new(AtomicUsize::new(0));
    let counted = posts.clone();
    let router = crate::http::router(app.clone()).layer(axum::middleware::from_fn(
        move |request: axum::extract::Request, next: axum::middleware::Next| {
            let counted = counted.clone();
            async move {
                let cancel = request.method() == axum::http::Method::POST
                    && request.uri().path().ends_with("/cancel");
                let response = next.run(request).await;
                if cancel
                    && response.status() == StatusCode::OK
                    && counted.fetch_add(1, Ordering::SeqCst) == 0
                {
                    let (parts, _) = response.into_parts();
                    axum::response::Response::from_parts(
                        parts,
                        axum::body::Body::from_stream(futures_util::stream::once(async {
                            Err::<Vec<u8>, _>(std::io::Error::other(
                                "disposable lost root backup cancellation",
                            ))
                        })),
                    )
                } else {
                    response
                }
            }
        },
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let sdk = rv_client::NativeClient::new(&format!("http://{address}")).unwrap();
    sdk.update_token(token);
    let original = request(&keys, None);
    assert!(sdk.cancel_crypto_root_backup(&original).await.is_err());
    let receipt = cancelled_metadata(sdk.cancel_crypto_root_backup(&original).await.unwrap());
    assert_eq!(receipt.operation_id, original.operation_id);
    assert_eq!(posts.load(Ordering::SeqCst), 2);
    let rv_client::Error::Server { code, .. } = sdk
        .publish_crypto_root_backup(&original)
        .await
        .err()
        .unwrap()
    else {
        panic!("wrong refusal")
    };
    assert_eq!(code, "crypto_backup_cancelled");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM e2ee_root_backup_cancellations WHERE user_id=$1")
            .bind(&owner.id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
    server.abort();
}
