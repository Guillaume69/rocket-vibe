use super::*;
use rv_crypto_public::recovery::{Header, Publication, PublicationBody, RootBackup};

#[test]
fn root_backup_contract_fixture_is_authentic_and_rejects_secret_fields() {
    let fixture: rv_protocol::Contract =
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let input = fixture.parity.e2ee_publish_root_backup.unwrap();
    let active = fixture.parity.e2ee_root_backup.unwrap().active.unwrap();
    let p = Publication::from_bytes(&B64.decode(input.publication.as_bytes()).unwrap()).unwrap();
    assert_eq!(p.body.operation, input.operation_id);
    assert_eq!(active.receipt.packet_digest, hex(&p.body.packet_digest));
    assert_eq!(active.receipt.backup_revision, "9007199254740993");
    for field in ["recovery_code", "private_key", "seed", "plaintext"] {
        let mut value = serde_json::to_value(&input).unwrap();
        value[field] = serde_json::json!("forbidden");
        assert!(serde_json::from_value::<wire::PublishRootBackup>(value).is_err());
    }
}

async fn enrolled(pool: PgPool) -> (App, Account, String, Client) {
    let app = App::from_pool(pool).await.unwrap();
    let (owner, token) = actor(&app, "backup-owner").await;
    let keys = client(&app, &owner, None).await;
    register(&app, &owner, keys.registration.clone())
        .await
        .unwrap();
    (app, owner, token, keys)
}
// Public server verification uses opaque bytes. Actual AEAD is exercised in
// the private SDK; the server never links that crate or receives its secret.
fn request(keys: &Client, expected: Option<&str>) -> wire::PublishRootBackup {
    let packet = RootBackup {
        header: Header {
            version: 1,
            root: keys.root.clone(),
            backup_id: random_bytes(),
            created_at: Utc::now().timestamp() as u64,
        },
        nonce: random_bytes(),
        ciphertext: vec![137; 192],
    };
    let body = PublicationBody {
        version: 1,
        scope: rv_crypto_public::recovery::Scope {
            instance: keys.registration.scope.instance_id.clone(),
            data_epoch: keys.registration.scope.data_epoch.clone(),
        },
        operation: auth::random_token(),
        device: keys.certificate.device.device.clone(),
        incarnation: keys.certificate.device.incarnation,
        device_revision: "1".into(),
        expected_revision: expected.map(str::to_owned),
        packet_digest: packet.digest().unwrap(),
    };
    let publication = Publication {
        signature: keys
            .signing
            .sign(&body.signing_bytes().unwrap())
            .to_bytes()
            .to_vec(),
        body,
        packet,
    };
    wire::PublishRootBackup {
        scope: keys.registration.scope.clone(),
        operation_id: publication.body.operation.clone(),
        publication: B64.encode(&publication.to_bytes().unwrap()),
    }
}
fn mutate(
    input: &wire::PublishRootBackup,
    keys: &Client,
    change: impl FnOnce(&mut Publication),
) -> wire::PublishRootBackup {
    let mut publication =
        Publication::from_bytes(&B64.decode(input.publication.as_bytes()).unwrap()).unwrap();
    change(&mut publication);
    publication.signature = keys
        .signing
        .sign(&publication.body.signing_bytes().unwrap())
        .to_bytes()
        .to_vec();
    let mut changed = input.clone();
    changed.publication = B64.encode(&serde_json::to_vec(&publication).unwrap());
    changed
}
fn equal(left: &wire::RootBackupReceipt, right: &wire::RootBackupReceipt) {
    assert_eq!(
        serde_json::to_value(left).unwrap(),
        serde_json::to_value(right).unwrap()
    );
}

#[sqlx::test]
async fn concurrent_root_backup_replays_one_receipt_and_keeps_it_after_replacement(pool: PgPool) {
    let (app, owner, _, keys) = enrolled(pool).await;
    let original = request(&keys, None);
    let (left, right) = tokio::join!(
        backups::publish(&app, &owner, original.clone()),
        backups::publish(&app, &owner, original.clone())
    );
    let receipt = left.unwrap();
    equal(&receipt, &right.unwrap());
    assert_eq!(receipt.backup_revision, "1");
    assert_eq!(receipt.device_id, keys.certificate.device.device);
    let replacement = request(&keys, Some("1"));
    let replacement_receipt = backups::publish(&app, &owner, replacement.clone())
        .await
        .unwrap();
    assert_eq!(replacement_receipt.backup_revision, "2");
    let active = backups::current(&app, &owner)
        .await
        .unwrap()
        .active
        .unwrap();
    assert_eq!(active.publication, replacement.publication);
    equal(&active.receipt, &replacement_receipt);
    equal(
        &backups::operation(&app, &owner, &original.operation_id)
            .await
            .unwrap(),
        &receipt,
    );
    equal(
        &backups::publish(&app, &owner, original.clone())
            .await
            .unwrap(),
        &receipt,
    );
    let stale = request(&keys, Some("1"));
    assert_eq!(
        backups::publish(&app, &owner, stale)
            .await
            .err()
            .unwrap()
            .code,
        "backup_revision_conflict"
    );
    let substituted = mutate(&original, &keys, |p| {
        p.packet.nonce[0] ^= 1;
        p.body.packet_digest = p.packet.digest().unwrap();
    });
    assert_eq!(
        backups::publish(&app, &owner, substituted)
            .await
            .err()
            .unwrap()
            .code,
        "operation_conflict"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_root_backup_operations")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
}

#[sqlx::test]
async fn rootless_sessions_tampering_scope_and_stale_controller_cannot_replace_backup(
    pool: PgPool,
) {
    let (app, owner, _, keys) = enrolled(pool).await;
    let original = request(&keys, None);
    let mut tampered = original.clone();
    let mut publication: Publication =
        serde_json::from_slice(&B64.decode(original.publication.as_bytes()).unwrap()).unwrap();
    publication.packet.ciphertext[0] ^= 1;
    tampered.publication = B64.encode(&serde_json::to_vec(&publication).unwrap());
    assert_eq!(
        backups::publish(&app, &owner, tampered)
            .await
            .err()
            .unwrap()
            .code,
        "crypto_proof_invalid"
    );
    for altered in [
        mutate(&original, &keys, |p| p.body.device_revision = "2".into()),
        mutate(&original, &keys, |p| p.body.incarnation[0] ^= 1),
        mutate(&original, &keys, |p| {
            p.body.scope.data_epoch = "foreign-epoch".into()
        }),
        mutate(&original, &keys, |p| {
            p.body.operation = "different-operation".into()
        }),
    ] {
        assert!(backups::publish(&app, &owner, altered).await.is_err());
    }
    let (new_device, _) = login(&app, "backup-owner").await;
    assert_eq!(
        backups::publish(&app, &new_device, original.clone())
            .await
            .err()
            .unwrap()
            .code,
        "crypto_device_revoked"
    );
    let (stranger, _) = actor(&app, "backup-stranger").await;
    assert!(
        backups::publish(&app, &stranger, original.clone())
            .await
            .is_err()
    );
    assert!(
        backups::current(&app, &stranger)
            .await
            .unwrap()
            .active
            .is_none()
    );
    assert!(
        backups::current(&app, &owner)
            .await
            .unwrap()
            .active
            .is_none()
    );
    let mut wrong_epoch = original.clone();
    wrong_epoch.scope.data_epoch = "changed".into();
    assert_eq!(
        backups::publish(&app, &owner, wrong_epoch)
            .await
            .err()
            .unwrap()
            .code,
        "data_epoch_changed"
    );
    // The signed root proof grants neither HTTP access nor a different sender.
    backups::publish(&app, &owner, original).await.unwrap();
}

#[sqlx::test]
async fn backup_requires_recent_auth_but_original_receipt_remains_readable_after_expiry(
    pool: PgPool,
) {
    let (app, owner, _, keys) = enrolled(pool).await;
    let original = request(&keys, None);
    let receipt = backups::publish(&app, &owner, original.clone())
        .await
        .unwrap();
    sqlx::query(
        "UPDATE session_devices SET created_at=clock_timestamp()-interval '1 day' WHERE id=$1",
    )
    .bind(&receipt.device_id)
    .execute(&app.pool)
    .await
    .unwrap();
    let second = request(&keys, Some("1"));
    assert_eq!(
        backups::publish(&app, &owner, second.clone())
            .await
            .err()
            .unwrap()
            .code,
        "reauthentication_required"
    );
    equal(
        &backups::publish(&app, &owner, original.clone())
            .await
            .unwrap(),
        &receipt,
    );
    equal(
        &backups::operation(&app, &owner, &original.operation_id)
            .await
            .unwrap(),
        &receipt,
    );
    // A restored server epoch exposes the encrypted active packet for a new
    // recovery, but cannot settle an original intent from the previous epoch.
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
    let active = backups::current(&app, &owner).await.unwrap();
    assert_ne!(active.scope.data_epoch, receipt.scope.data_epoch);
    equal(&active.active.unwrap().receipt, &receipt);
}

#[sqlx::test]
async fn root_backup_quota_preserves_original_and_refuses_another_intention(pool: PgPool) {
    let (app, owner, _, keys) = enrolled(pool).await;
    let original = request(&keys, None);
    let receipt = backups::publish(&app, &owner, original.clone())
        .await
        .unwrap();
    sqlx::query("INSERT INTO e2ee_root_backup_operations(user_id,device_id,operation_id,fingerprint,receipt) SELECT $1,$2,'quota-'||n,'fixture',$3 FROM generate_series(1,63) n")
        .bind(&owner.id).bind(&receipt.device_id).bind(serde_json::to_value(&receipt).unwrap()).execute(&app.pool).await.unwrap();
    assert_eq!(
        backups::publish(&app, &owner, request(&keys, Some("1")))
            .await
            .err()
            .unwrap()
            .code,
        "crypto_backup_limit"
    );
    equal(
        &backups::publish(&app, &owner, original).await.unwrap(),
        &receipt,
    );
    assert_eq!(
        backups::current(&app, &owner)
            .await
            .unwrap()
            .active
            .unwrap()
            .receipt
            .backup_revision,
        "1"
    );
}

#[sqlx::test]
async fn root_backup_lost_http_response_is_read_without_second_post_and_fresh_device_can_fetch_packet(
    pool: PgPool,
) {
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
                let backup = request.method() == axum::http::Method::POST
                    && request.uri().path() == "/api/v1/e2ee/root-backup";
                let response = next.run(request).await;
                if backup && response.status() == StatusCode::OK {
                    assert_eq!(counted.fetch_add(1, Ordering::SeqCst), 0);
                    let (parts, _) = response.into_parts();
                    axum::response::Response::from_parts(
                        parts,
                        axum::body::Body::from_stream(futures_util::stream::once(async {
                            Err::<Vec<u8>, _>(std::io::Error::other(
                                "disposable lost root backup response",
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
    assert!(sdk.publish_crypto_root_backup(&original).await.is_err());
    let receipt = sdk
        .crypto_root_backup_operation(&original.operation_id)
        .await
        .unwrap();
    assert_eq!(receipt.operation_id, original.operation_id);
    assert_eq!(receipt.backup_revision, "1");
    assert_eq!(posts.load(Ordering::SeqCst), 1);
    let (_, fresh_token) = login(&app, "backup-owner").await;
    let fresh = rv_client::NativeClient::new(&format!("http://{address}")).unwrap();
    fresh.update_token(fresh_token);
    assert_eq!(
        fresh
            .crypto_root_backup()
            .await
            .unwrap()
            .active
            .unwrap()
            .publication,
        original.publication
    );
    assert!(
        fresh
            .crypto_root_backup_operation(&original.operation_id)
            .await
            .is_err()
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_devices WHERE user_id=$1")
        .bind(&owner.id)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(count, 1); // Downloading an encrypted root never enrolls its reader.
    server.abort();
}
