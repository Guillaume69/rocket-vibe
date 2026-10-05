use super::*;

#[test]
fn public_revocation_fixture_has_an_authentic_target_and_root() {
    let fixture: rv_protocol::Contract =
        serde_json::from_str(include_str!("../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let original = fixture.parity.e2ee_revoke_device.unwrap();
    let signed: Revocation =
        serde_json::from_slice(&B64.decode(original.signed.as_bytes()).unwrap()).unwrap();
    signed.verify().unwrap();
    assert_eq!(signed.root.instance, original.scope.instance_id);
    assert_eq!(signed.device, "fixture-revoked-peer");
    let mut changed = signed;
    changed.incarnation[0] ^= 1;
    assert!(changed.verify().is_err());
}

struct Pilot {
    app: App,
    controller: Account,
    controller_token: String,
    keys: Client,
    target: Account,
    target_token: String,
    target_keys: Client,
}
impl Pilot {
    async fn new(pool: PgPool) -> Self {
        let app = App::from_pool(pool).await.unwrap();
        let (controller, controller_token) = actor(&app, "revocation-owner").await;
        let keys = client(&app, &controller, None).await;
        let receipt = register(&app, &controller, keys.registration.clone())
            .await
            .unwrap();
        let (target, target_token) = login(&app, "revocation-owner").await;
        let mut target_keys = client(
            &app,
            &target,
            Some((keys.root.clone(), keys.signing.clone())),
        )
        .await;
        target_keys.registration.expected_root_fingerprint = Some(receipt.root_fingerprint);
        register(&app, &target, target_keys.registration.clone())
            .await
            .unwrap();
        Self {
            app,
            controller,
            controller_token,
            keys,
            target,
            target_token,
            target_keys,
        }
    }
    fn request(&self, device: &str, incarnation: [u8; 16]) -> wire::RevokeDevice {
        let mut signed = Revocation {
            root: self.keys.root.clone(),
            device: device.into(),
            incarnation,
            signature: vec![],
        };
        signed.signature = self
            .keys
            .signing
            .sign(&signed.body().unwrap())
            .to_bytes()
            .to_vec();
        wire::RevokeDevice {
            scope: self.keys.registration.scope.clone(),
            operation_id: auth::random_token(),
            device_revision: "1".into(),
            incarnation: hex(&self.keys.certificate.device.incarnation),
            signed: B64.encode(&serde_json::to_vec(&signed).unwrap()),
        }
    }
    fn target_request(&self) -> wire::RevokeDevice {
        self.request(
            &self.target_keys.certificate.device.device,
            self.target_keys.certificate.device.incarnation,
        )
    }
}

#[sqlx::test]
async fn root_signed_withdrawal_retires_http_family_and_packages_and_keeps_exact_controller_receipt(
    pool: PgPool,
) {
    let f = Pilot::new(pool).await;
    let published = publish(&f.app, &f.target, packages(&f.target_keys, "1", 2))
        .await
        .unwrap();
    let original = f.target_request();
    let receipt = revoke(&f.app, &f.controller, original.clone())
        .await
        .unwrap();
    assert_eq!(receipt.kind, "revoke_device");
    assert_eq!(receipt.device_id, f.keys.certificate.device.device);
    assert_eq!(
        receipt.incarnation,
        hex(&f.keys.certificate.device.incarnation)
    );
    assert_eq!(receipt.device_revision, "1");
    assert!(receipt.key_package_refs.is_empty());
    assert_eq!(
        receipt.root_fingerprint,
        hex(&f.keys.root.fingerprint().unwrap())
    );
    assert!(
        auth::authenticate(&f.app, &auth::hash_token(&f.target_token))
            .await
            .is_err()
    );
    assert!(
        auth::authenticate(&f.app, &auth::hash_token(&f.controller_token))
            .await
            .is_ok()
    );
    let unspent: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_key_packages WHERE reference=ANY($1) AND (NOT spent OR wire IS NOT NULL)")
        .bind(&published.key_package_refs).fetch_one(&f.app.pool).await.unwrap();
    assert_eq!(unspent, 0);
    let current = directory(&f.app, &f.controller.id, None).await.unwrap();
    assert_eq!(current.devices.len(), 1);
    assert_eq!(current.revocations.len(), 1);
    let signed: Revocation = serde_json::from_slice(
        &B64.decode(current.revocations[0].signed.as_bytes())
            .unwrap(),
    )
    .unwrap();
    signed.verify().unwrap();
    assert_eq!(signed.device, f.target_keys.certificate.device.device);
    assert_eq!(
        signed.incarnation,
        f.target_keys.certificate.device.incarnation
    );
    // The original receipt remains recoverable after the fresh-auth window;
    // replay never emits another withdrawal or requires a second authorization.
    sqlx::query(
        "UPDATE session_devices SET created_at=clock_timestamp()-interval '1 hour' WHERE id=$1",
    )
    .bind(&receipt.device_id)
    .execute(&f.app.pool)
    .await
    .unwrap();
    let replay = revoke(&f.app, &f.controller, original.clone())
        .await
        .unwrap();
    let observed = operation(&f.app, &f.controller, &original.operation_id)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&receipt).unwrap(),
        serde_json::to_value(replay).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&receipt).unwrap(),
        serde_json::to_value(observed).unwrap()
    );
    let mut substituted = original.clone();
    substituted.signed = f.request("another-leaf", random_bytes()).signed;
    rejected(
        revoke(&f.app, &f.controller, substituted).await,
        "operation_conflict",
    );
    let mut fresh = original;
    fresh.operation_id = auth::random_token();
    rejected(
        revoke(&f.app, &f.controller, fresh).await,
        "reauthentication_required",
    );
    assert!(!rv_protocol::Capabilities::default().e2ee);
}

#[sqlx::test]
async fn withdrawal_refuses_forgery_foreign_root_stale_sender_and_self_and_preserves_target(
    pool: PgPool,
) {
    let f = Pilot::new(pool).await;
    let original = f.target_request();
    let mut forged = original.clone();
    let mut signed: Revocation =
        serde_json::from_slice(&B64.decode(forged.signed.as_bytes()).unwrap()).unwrap();
    signed.signature[0] ^= 1;
    forged.signed = B64.encode(&serde_json::to_vec(&signed).unwrap());
    rejected(
        revoke(&f.app, &f.controller, forged).await,
        "crypto_proof_invalid",
    );
    let (stranger, stranger_token) = actor(&f.app, "revocation-stranger").await;
    rejected(
        revoke(&f.app, &stranger, original.clone()).await,
        "crypto_identity_changed",
    );
    let mut stale = original.clone();
    stale.device_revision = "2".into();
    rejected(
        revoke(&f.app, &f.controller, stale).await,
        "revision_conflict",
    );
    let mut wrong_incarnation = original.clone();
    wrong_incarnation.incarnation = hex(&random_bytes::<16>());
    rejected(
        revoke(&f.app, &f.controller, wrong_incarnation).await,
        "revision_conflict",
    );
    let mut epoch = original.clone();
    epoch.scope.data_epoch = "substituted-epoch".into();
    rejected(
        revoke(&f.app, &f.controller, epoch).await,
        "data_epoch_changed",
    );
    rejected(
        revoke(
            &f.app,
            &f.controller,
            f.request(
                &f.keys.certificate.device.device,
                f.keys.certificate.device.incarnation,
            ),
        )
        .await,
        "invalid_request",
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_revocations")
        .fetch_one(&f.app.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(
        auth::authenticate(&f.app, &auth::hash_token(&f.target_token))
            .await
            .is_ok()
    );
    // An HTTP admin cannot withdraw another user's root without its signature.
    sqlx::query("UPDATE users SET admin=true WHERE id=$1")
        .bind(&stranger.id)
        .execute(&f.app.pool)
        .await
        .unwrap();
    let admin = auth::authenticate(&f.app, &auth::hash_token(&stranger_token))
        .await
        .unwrap();
    assert!(admin.admin);
    rejected(
        revoke(&f.app, &admin, original).await,
        "crypto_identity_changed",
    );
}

#[sqlx::test]
async fn historical_withdrawal_never_deletes_a_replacement_incarnation_and_deleted_families_still_get_a_signed_tombstone(
    pool: PgPool,
) {
    let f = Pilot::new(pool).await;
    let current = &f.target_keys.certificate.device;
    let mut replacement = client(
        &f.app,
        &f.target,
        Some((f.keys.root.clone(), f.keys.signing.clone())),
    )
    .await;
    assert_ne!(
        replacement.certificate.device.incarnation,
        current.incarnation
    );
    replacement.registration.expected_root_fingerprint =
        Some(hex(&f.keys.root.fingerprint().unwrap()));
    replacement.registration.expected_device_revision = Some("1".into());
    replacement.registration.revoke_previous = Some(f.target_request().signed);
    assert_eq!(
        register(&f.app, &f.target, replacement.registration)
            .await
            .unwrap()
            .device_revision,
        "2"
    );
    let request = f.target_request();
    let (left, right) = tokio::join!(
        revoke(&f.app, &f.controller, request.clone()),
        revoke(&f.app, &f.controller, request)
    );
    assert_eq!(
        serde_json::to_value(left.unwrap()).unwrap(),
        serde_json::to_value(right.unwrap()).unwrap()
    );
    assert!(
        auth::authenticate(&f.app, &auth::hash_token(&f.target_token))
            .await
            .is_ok()
    );
    assert_eq!(
        directory(&f.app, &f.controller.id, None)
            .await
            .unwrap()
            .revocations
            .len(),
        1
    );
    crate::sessions::revoke(&f.app, &f.controller, Some(&current.device))
        .await
        .unwrap();
    revoke(
        &f.app,
        &f.controller,
        f.request(&current.device, replacement.certificate.device.incarnation),
    )
    .await
    .unwrap();
    let current = directory(&f.app, &f.controller.id, None).await.unwrap();
    assert_eq!(current.revocations.len(), 2);
    assert!(
        current.revocations[0].position.parse::<u64>().unwrap()
            < current.revocations[1].position.parse::<u64>().unwrap()
    );
}

#[sqlx::test]
async fn lost_http_withdrawal_response_is_observed_by_sdk_receipt_without_a_second_post(
    pool: PgPool,
) {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let f = Pilot::new(pool).await;
    let posts = Arc::new(AtomicUsize::new(0));
    let counted = posts.clone();
    let router = crate::http::router(f.app.clone()).layer(axum::middleware::from_fn(
        move |request: axum::extract::Request, next: axum::middleware::Next| {
            let counted = counted.clone();
            async move {
                let revoke = request.method() == axum::http::Method::POST
                    && request.uri().path() == "/api/v1/e2ee/revocations";
                let response = next.run(request).await;
                if revoke && response.status() == StatusCode::OK {
                    assert_eq!(counted.fetch_add(1, Ordering::SeqCst), 0);
                    let (parts, _) = response.into_parts();
                    axum::response::Response::from_parts(
                        parts,
                        axum::body::Body::from_stream(futures_util::stream::once(async {
                            Err::<Vec<u8>, _>(std::io::Error::other(
                                "disposable lost revocation response",
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
    sdk.update_token(f.controller_token.clone());
    let original = f.target_request();
    assert!(sdk.revoke_crypto_device(&original).await.is_err());
    let receipt = sdk.crypto_operation(&original.operation_id).await.unwrap();
    assert_eq!(receipt.kind, "revoke_device");
    assert_eq!(receipt.operation_id, original.operation_id);
    assert_eq!(receipt.device_id, f.keys.certificate.device.device);
    assert_eq!(posts.load(Ordering::SeqCst), 1);
    assert!(
        auth::authenticate(&f.app, &auth::hash_token(&f.target_token))
            .await
            .is_err()
    );
    assert_eq!(
        directory(&f.app, &f.controller.id, None)
            .await
            .unwrap()
            .revocations
            .len(),
        1
    );
    server.abort();
}

#[sqlx::test]
async fn expired_own_certificate_remains_visible_to_its_owner_and_can_renew_over_actual_http(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let (owner, token) = actor(&app, "expired-directory-owner").await;
    let mut keys = client(&app, &owner, None).await;
    issue(&mut keys, Utc::now().timestamp() as u64, 5);
    let initial = register(&app, &owner, keys.registration.clone())
        .await
        .unwrap();
    let expires = keys.certificate.device.expires_at;
    let (observer, observer_token) = actor(&app, "expired-directory-observer").await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = crate::http::router(app.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let sdk = rv_client::NativeClient::new(&format!("http://{address}")).unwrap();
    sdk.update_token(token);
    let peer = rv_client::NativeClient::new(&format!("http://{address}")).unwrap();
    peer.update_token(observer_token);
    tokio::time::timeout(std::time::Duration::from_secs(8), async {
        while (Utc::now().timestamp() as u64) < expires {
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        keys.certificate
            .verify(Utc::now().timestamp() as u64)
            .is_err()
    );
    let owned = sdk.crypto_directory(&owner.id, None).await.unwrap();
    assert_eq!(owned.devices.len(), 1);
    assert_eq!(owned.devices[0].revision, initial.device_revision);
    let historical: Certificate =
        serde_json::from_slice(&B64.decode(owned.devices[0].certificate.as_bytes()).unwrap())
            .unwrap();
    historical.authenticate().unwrap();
    assert!(historical.verify(Utc::now().timestamp() as u64).is_err());
    assert!(
        peer.crypto_directory(&owner.id, None)
            .await
            .unwrap()
            .devices
            .is_empty()
    );
    assert!(
        directory(&app, &owner.id, None)
            .await
            .unwrap()
            .devices
            .is_empty()
    );
    assert_ne!(owner.id, observer.id);
    issue(&mut keys, Utc::now().timestamp() as u64, 7200);
    keys.registration.operation_id = auth::random_token();
    keys.registration.expected_root_fingerprint = Some(initial.root_fingerprint);
    keys.registration.expected_device_revision = Some("1".into());
    let renewed = sdk
        .register_crypto_device(&keys.registration)
        .await
        .unwrap();
    assert_eq!(renewed.device_revision, "2");
    assert_eq!(
        sdk.crypto_directory(&owner.id, None).await.unwrap().devices[0].revision,
        "2"
    );
    assert_eq!(
        peer.crypto_directory(&owner.id, None)
            .await
            .unwrap()
            .devices[0]
            .revision,
        "2"
    );
    server.abort();
}
