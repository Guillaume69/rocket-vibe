use super::*;
use ed25519_dalek::{Signer as _, SigningKey};
use openmls::prelude::{Ciphersuite, CredentialWithKey, KeyPackage, tls_codec::Serialize as _};
use openmls_basic_credential::SignatureKeyPair;
use openmls_traits::signatures::Signer as _;
use rv_crypto_public::{
    CERT_DOMAIN, Device, Root,
    enrollment::{REQUEST_DOMAIN, RequestBody},
    signing_bytes,
};
use sqlx::PgPool;

const PASSWORD: &str = "disposable-e2ee-directory-password";

#[path = "revocations/tests.rs"]
mod device_revocations;
#[path = "groups/tests.rs"]
mod group_delivery;
#[path = "history_backup/tests.rs"]
mod history_backups;
#[path = "history/tests.rs"]
mod history_shares;
#[path = "backups/tests.rs"]
mod root_backups;
const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
struct Client {
    root: Root,
    signing: SigningKey,
    leaf: SignatureKeyPair,
    certificate: Certificate,
    registration: wire::RegisterDevice,
}
fn random_bytes<const N: usize>() -> [u8; N] {
    data_encoding::HEXLOWER
        .decode(auth::random_token().as_bytes())
        .unwrap()[..N]
        .try_into()
        .unwrap()
}
async fn actor(app: &App, username: &str) -> (Account, String) {
    auth::create_user(app, username, PASSWORD.into(), false)
        .await
        .unwrap();
    login(app, username).await
}
async fn login(app: &App, username: &str) -> (Account, String) {
    let session = auth::login(app, username.into(), PASSWORD.into())
        .await
        .unwrap();
    (
        auth::authenticate(app, &auth::hash_token(&session.token))
            .await
            .unwrap(),
        session.token,
    )
}
fn issue(client: &mut Client, now: u64, lifetime: u64) {
    let device = client.certificate.device.device.clone();
    let incarnation = client.certificate.device.incarnation;
    let body = RequestBody {
        version: 1,
        root: client.root.clone(),
        device: device.clone(),
        incarnation,
        request_id: random_bytes(),
        signature_key: client.leaf.to_public_vec().try_into().unwrap(),
        issued_at: now,
        expires_at: now + 600,
    };
    let request = Request {
        signature: client
            .leaf
            .sign(&signing_bytes(REQUEST_DOMAIN, &body).unwrap())
            .unwrap(),
        body,
    };
    let certificate = Device {
        version: 1,
        root: client.root.clone(),
        device,
        incarnation,
        serial: random_bytes(),
        suite: 1,
        signature_key: client.leaf.to_public_vec().try_into().unwrap(),
        issued_at: now,
        expires_at: now + lifetime,
    };
    client.certificate = Certificate {
        signature: client
            .signing
            .sign(&signing_bytes(CERT_DOMAIN, &certificate).unwrap())
            .to_bytes()
            .to_vec(),
        device: certificate,
    };
    let mut grant = Grant {
        request: request.fingerprint().unwrap(),
        certificate: client.certificate.clone(),
        signature: Vec::new(),
    };
    grant.signature = client
        .signing
        .sign(&grant.body().unwrap())
        .to_bytes()
        .to_vec();
    client.registration.request = B64.encode(&request.to_bytes().unwrap());
    client.registration.grant = B64.encode(&grant.to_bytes().unwrap());
}
async fn client(app: &App, actor: &Account, root: Option<(Root, SigningKey)>) -> Client {
    let (instance_id, data_epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton")
            .fetch_one(&app.pool)
            .await
            .unwrap();
    let device: String = sqlx::query_scalar("SELECT device_id FROM sessions WHERE token_hash=$1")
        .bind(&actor.session_hash)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    let (root, signing) = root.unwrap_or_else(|| {
        let signing = SigningKey::from_bytes(&random_bytes());
        (
            Root {
                version: 1,
                instance: instance_id.clone(),
                user: actor.id.clone(),
                generation: random_bytes(),
                public_key: signing.verifying_key().to_bytes(),
            },
            signing,
        )
    });
    let leaf = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
    let certificate = Certificate {
        signature: Vec::new(),
        device: Device {
            version: 1,
            root: root.clone(),
            device,
            incarnation: random_bytes(),
            serial: random_bytes(),
            suite: 1,
            signature_key: leaf.to_public_vec().try_into().unwrap(),
            issued_at: 0,
            expires_at: 0,
        },
    };
    let mut client = Client {
        root,
        signing,
        leaf,
        certificate,
        registration: wire::RegisterDevice {
            scope: Scope {
                instance_id,
                data_epoch,
            },
            operation_id: auth::random_token(),
            expected_root_fingerprint: None,
            expected_device_revision: None,
            request: String::new(),
            grant: String::new(),
            revoke_previous: None,
        },
    };
    issue(&mut client, Utc::now().timestamp() as u64, 86400);
    client
}
fn packages(client: &Client, revision: &str, count: usize) -> wire::PublishKeyPackages {
    packages_with_signer(client, &client.leaf, revision, count)
}
fn packages_with_signer(
    client: &Client,
    signer: &SignatureKeyPair,
    revision: &str,
    count: usize,
) -> wire::PublishKeyPackages {
    let provider = OpenMlsRustCrypto::default();
    let credential = CredentialWithKey {
        credential: client.certificate.credential().unwrap(),
        signature_key: signer.to_public_vec().into(),
    };
    let packages = (0..count)
        .map(|_| {
            KeyPackage::builder()
                .build(SUITE, &provider, signer, credential.clone())
                .unwrap()
                .key_package()
                .tls_serialize_detached()
                .unwrap()
        })
        .map(|wire| B64.encode(&wire))
        .collect();
    wire::PublishKeyPackages {
        scope: client.registration.scope.clone(),
        operation_id: auth::random_token(),
        device_revision: revision.into(),
        packages,
    }
}
fn rejected<T>(result: Result<T>, code: &str) {
    assert_eq!(result.err().expect("request must fail").code, code);
}

#[sqlx::test]
async fn registration_and_package_receipts_are_durable_and_public_keys_do_not_enable_e2ee(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let (actor, _) = actor(&app, "crypto-owner").await;
    let client = client(&app, &actor, None).await;
    let registered = register(&app, &actor, client.registration.clone())
        .await
        .unwrap();
    assert_eq!(registered.device_revision, "1");
    let replay = register(&app, &actor, client.registration.clone())
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(registered).unwrap(),
        serde_json::to_value(replay).unwrap()
    );
    let directory = directory(&app, &actor.id, None).await.unwrap();
    assert_eq!(directory.devices.len(), 1);
    assert_eq!(
        directory.identity.unwrap().fingerprint,
        hex(&client.root.fingerprint().unwrap())
    );
    let input = packages(&client, "1", 2);
    let first = publish(&app, &actor, input.clone()).await.unwrap();
    assert_eq!(first.key_package_refs.len(), 2);
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(publish(&app, &actor, input.clone()).await.unwrap()).unwrap()
    );
    let durable = operation(&app, &actor, &input.operation_id).await.unwrap();
    assert_eq!(
        serde_json::to_value(first).unwrap(),
        serde_json::to_value(durable).unwrap()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM e2ee_key_packages")
            .fetch_one(&app.pool)
            .await
            .unwrap(),
        2
    );
    assert!(!rv_protocol::Capabilities::default().e2ee);
}

#[sqlx::test]
async fn proofs_are_bound_to_account_instance_session_and_pinned_root(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let (owner, _) = actor(&app, "proof-owner").await;
    let (stranger, _) = actor(&app, "proof-stranger").await;
    let first = client(&app, &owner, None).await;
    rejected(
        register(&app, &stranger, first.registration.clone()).await,
        "crypto_proof_invalid",
    );
    let other_instance = Root {
        instance: auth::random_token(),
        ..first.root.clone()
    };
    let foreign = client(&app, &owner, Some((other_instance, first.signing.clone()))).await;
    rejected(
        register(&app, &owner, foreign.registration).await,
        "crypto_proof_invalid",
    );
    let (other_session, _) = login(&app, "proof-owner").await;
    rejected(
        register(&app, &other_session, first.registration.clone()).await,
        "crypto_proof_invalid",
    );
    let mut forged = first.registration.clone();
    let mut grant = Grant::from_bytes(&B64.decode(forged.grant.as_bytes()).unwrap()).unwrap();
    grant.signature[0] ^= 1;
    forged.grant = B64.encode(&grant.to_bytes().unwrap());
    rejected(register(&app, &owner, forged).await, "crypto_proof_invalid");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM e2ee_identities")
            .fetch_one(&app.pool)
            .await
            .unwrap(),
        0
    );

    let original = register(&app, &owner, first.registration.clone())
        .await
        .unwrap();
    let mut replacement = client(&app, &owner, None).await;
    replacement.registration.expected_root_fingerprint = Some(original.root_fingerprint.clone());
    replacement.registration.expected_device_revision = Some("1".into());
    rejected(
        register(&app, &owner, replacement.registration).await,
        "crypto_identity_changed",
    );
    let mut second = client(
        &app,
        &other_session,
        Some((first.root.clone(), first.signing.clone())),
    )
    .await;
    rejected(
        register(&app, &other_session, second.registration.clone()).await,
        "crypto_identity_changed",
    );
    second.registration.expected_root_fingerprint = Some(original.root_fingerprint.clone());
    register(&app, &other_session, second.registration)
        .await
        .unwrap();
    assert_eq!(
        directory(&app, &owner.id, None)
            .await
            .unwrap()
            .devices
            .len(),
        2
    );
}

#[sqlx::test]
async fn concurrent_retries_renewal_and_conflicting_intentions_keep_one_head(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let (owner, _) = actor(&app, "retry-owner").await;
    let mut first = client(&app, &owner, None).await;
    let (left, right) = tokio::join!(
        register(&app, &owner, first.registration.clone()),
        register(&app, &owner, first.registration.clone())
    );
    let receipt = left.unwrap();
    assert_eq!(
        serde_json::to_value(&receipt).unwrap(),
        serde_json::to_value(right.unwrap()).unwrap()
    );
    let mut conflict = first.registration.clone();
    conflict.expected_device_revision = Some("1".into());
    rejected(register(&app, &owner, conflict).await, "operation_conflict");
    first.registration.operation_id = auth::random_token();
    first.registration.expected_root_fingerprint = Some(receipt.root_fingerprint.clone());
    rejected(
        register(&app, &owner, first.registration.clone()).await,
        "revision_conflict",
    );
    first.registration.expected_device_revision = Some("1".into());
    let mut downgrade = first.registration.clone();
    issue(&mut first, Utc::now().timestamp() as u64, 3600);
    rejected(
        register(&app, &owner, first.registration.clone()).await,
        "revision_conflict",
    );
    downgrade.operation_id = auth::random_token();
    register(&app, &owner, downgrade).await.unwrap();
    issue(&mut first, Utc::now().timestamp() as u64, 86401);
    first.registration.operation_id = auth::random_token();
    first.registration.expected_device_revision = Some("2".into());
    let renewed = register(&app, &owner, first.registration.clone())
        .await
        .unwrap();
    assert_eq!(renewed.device_revision, "3");
    let input = packages(&first, "3", 1);
    let (left, right) = tokio::join!(
        publish(&app, &owner, input.clone()),
        publish(&app, &owner, input.clone())
    );
    assert_eq!(
        serde_json::to_value(left.unwrap()).unwrap(),
        serde_json::to_value(right.unwrap()).unwrap()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM e2ee_key_packages")
            .fetch_one(&app.pool)
            .await
            .unwrap(),
        1
    );
}

#[sqlx::test]
async fn replacing_an_incarnation_requires_root_revocation_and_cannot_revive_old_packages(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let (owner, _) = actor(&app, "rotation-owner").await;
    let first = client(&app, &owner, None).await;
    let registered = register(&app, &owner, first.registration.clone())
        .await
        .unwrap();
    let published = publish(&app, &owner, packages(&first, "1", 1))
        .await
        .unwrap();
    let mut replacement = client(
        &app,
        &owner,
        Some((first.root.clone(), first.signing.clone())),
    )
    .await;
    replacement.registration.expected_root_fingerprint = Some(registered.root_fingerprint.clone());
    replacement.registration.expected_device_revision = Some("1".into());
    rejected(
        register(&app, &owner, replacement.registration.clone()).await,
        "crypto_identity_changed",
    );
    let mut revoked = Revocation {
        root: first.root.clone(),
        device: first.certificate.device.device.clone(),
        incarnation: first.certificate.device.incarnation,
        signature: Vec::new(),
    };
    revoked.signature = first
        .signing
        .sign(&revoked.body().unwrap())
        .to_bytes()
        .to_vec();
    replacement.registration.revoke_previous =
        Some(B64.encode(&serde_json::to_vec(&revoked).unwrap()));
    let mut forged = replacement.registration.clone();
    revoked.signature[0] ^= 1;
    forged.revoke_previous = Some(B64.encode(&serde_json::to_vec(&revoked).unwrap()));
    rejected(register(&app, &owner, forged).await, "crypto_proof_invalid");
    let replacement_receipt = register(&app, &owner, replacement.registration.clone())
        .await
        .unwrap();
    assert_eq!(replacement_receipt.device_revision, "2");
    let (spent, bytes): (bool, Option<Vec<u8>>) =
        sqlx::query_as("SELECT spent,wire FROM e2ee_key_packages WHERE reference=$1")
            .bind(&published.key_package_refs[0])
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert!(spent && bytes.is_none());
    let mut stale = first.registration;
    stale.operation_id = auth::random_token();
    stale.expected_root_fingerprint = Some(registered.root_fingerprint);
    stale.expected_device_revision = Some("2".into());
    rejected(register(&app, &owner, stale).await, "crypto_device_revoked");
    let catalog = directory(&app, &owner.id, None).await.unwrap();
    assert_eq!(catalog.devices.len(), 1);
    assert_eq!(
        catalog.devices[0].incarnation,
        replacement_receipt.incarnation
    );
    assert_eq!(catalog.revocations.len(), 1);
    let signed: Revocation = serde_json::from_slice(
        &B64.decode(catalog.revocations[0].signed.as_bytes())
            .unwrap(),
    )
    .unwrap();
    signed.verify().unwrap();
    assert!(
        directory(&app, &owner.id, Some(&catalog.revocations[0].position))
            .await
            .unwrap()
            .revocations
            .is_empty()
    );
}

#[sqlx::test]
async fn key_packages_validate_mls_and_leaf_binding_and_batch_is_atomic(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let (owner, _) = actor(&app, "package-owner").await;
    let first = client(&app, &owner, None).await;
    register(&app, &owner, first.registration.clone())
        .await
        .unwrap();
    let impostor = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
    rejected(
        publish(
            &app,
            &owner,
            packages_with_signer(&first, &impostor, "1", 1),
        )
        .await,
        "crypto_proof_invalid",
    );
    let mut corrupted = packages(&first, "1", 2);
    let mut tls = B64.decode(corrupted.packages[1].as_bytes()).unwrap();
    *tls.last_mut().unwrap() ^= 1;
    corrupted.packages[1] = B64.encode(&tls);
    rejected(
        publish(&app, &owner, corrupted).await,
        "crypto_proof_invalid",
    );
    let mut duplicated = packages(&first, "1", 1);
    duplicated.packages.push(duplicated.packages[0].clone());
    rejected(publish(&app, &owner, duplicated).await, "invalid_request");
    rejected(
        publish(&app, &owner, packages(&first, "2", 1)).await,
        "revision_conflict",
    );
    rejected(
        publish(&app, &owner, packages(&first, "1", 9)).await,
        "invalid_request",
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM e2ee_key_packages")
            .fetch_one(&app.pool)
            .await
            .unwrap(),
        0
    );
    let mut final_batch = None;
    for _ in 0..8 {
        let batch = packages(&first, "1", 8);
        let receipt = publish(&app, &owner, batch.clone()).await.unwrap();
        final_batch = Some((batch, receipt));
    }
    let failed = packages(&first, "1", 1);
    rejected(
        publish(&app, &owner, failed.clone()).await,
        "crypto_key_package_limit",
    );
    rejected(
        operation(&app, &owner, &failed.operation_id).await,
        "not_found",
    );
    let (mut repeated, receipt) = final_batch.unwrap();
    sqlx::query("UPDATE e2ee_key_packages SET spent=true,wire=NULL WHERE reference=$1")
        .bind(&receipt.key_package_refs[0])
        .execute(&app.pool)
        .await
        .unwrap();
    repeated.operation_id = auth::random_token();
    publish(&app, &owner, repeated).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM e2ee_key_packages WHERE NOT spent")
            .fetch_one(&app.pool)
            .await
            .unwrap(),
        63
    );
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT spent FROM e2ee_key_packages WHERE reference=$1")
            .bind(&receipt.key_package_refs[0])
            .fetch_one(&app.pool)
            .await
            .unwrap()
    );
}

#[sqlx::test]
async fn session_rotation_preserves_crypto_while_logout_retires_packages_and_old_actor(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let (owner, token) = actor(&app, "session-owner").await;
    let first = client(&app, &owner, None).await;
    register(&app, &owner, first.registration.clone())
        .await
        .unwrap();
    let input = packages(&first, "1", 1);
    publish(&app, &owner, input.clone()).await.unwrap();
    let renewed = crate::sessions::renew(
        &app,
        &auth::hash_token(&token),
        rv_protocol::parity::RenewSession {
            operation_id: auth::random_token(),
            next_token: auth::random_token(),
        },
    )
    .await
    .unwrap();
    rejected(
        register(&app, &owner, first.registration.clone()).await,
        "session_rejected",
    );
    let current = auth::authenticate(&app, &auth::hash_token(&renewed.token))
        .await
        .unwrap();
    assert_eq!(
        directory(&app, &owner.id, None)
            .await
            .unwrap()
            .devices
            .len(),
        1
    );
    publish(&app, &current, input.clone()).await.unwrap();
    crate::sessions::revoke(&app, &current, None).await.unwrap();
    assert!(
        directory(&app, &owner.id, None)
            .await
            .unwrap()
            .devices
            .is_empty()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM e2ee_key_packages WHERE NOT spent OR wire IS NOT NULL"
        )
        .fetch_one(&app.pool)
        .await
        .unwrap(),
        0
    );
    rejected(publish(&app, &current, input).await, "session_rejected");
    rejected(
        operation(&app, &current, &first.registration.operation_id).await,
        "not_found",
    );
}

#[sqlx::test]
async fn generation_guard_and_expiration_hide_stale_devices_and_receipts(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let (owner, _) = actor(&app, "generation-owner").await;
    let first = client(&app, &owner, None).await;
    register(&app, &owner, first.registration.clone())
        .await
        .unwrap();
    sqlx::query("UPDATE e2ee_devices SET expires_at=EXTRACT(EPOCH FROM now())::bigint-1")
        .execute(&app.pool)
        .await
        .unwrap();
    assert!(
        directory(&app, &owner.id, None)
            .await
            .unwrap()
            .devices
            .is_empty()
    );
    rejected(
        publish(&app, &owner, packages(&first, "1", 1)).await,
        "crypto_device_revoked",
    );
    // A durable receipt describes the historical operation and cannot revive its head.
    register(&app, &owner, first.registration.clone())
        .await
        .unwrap();
    sqlx::query("UPDATE instance SET data_epoch=$1 WHERE singleton")
        .bind(auth::random_token())
        .execute(&app.pool)
        .await
        .unwrap();
    rejected(
        register(&app, &owner, first.registration.clone()).await,
        "data_epoch_changed",
    );
    rejected(
        operation(&app, &owner, &first.registration.operation_id).await,
        "data_epoch_changed",
    );
    rejected(
        directory(&app, &owner.id, Some("01")).await,
        "invalid_request",
    );
}

#[sqlx::test]
async fn http_directory_is_authenticated_uncached_and_rust_transport_replays_receipts(
    pool: PgPool,
) {
    use axum::{body::Body, http::Request as HttpRequest};
    use tower::ServiceExt;
    let app = App::from_pool(pool).await.unwrap();
    let (owner, token) = actor(&app, "http-crypto-owner").await;
    let first = client(&app, &owner, None).await;
    let router = crate::http::router(app.clone());
    let anonymous = router
        .clone()
        .oneshot(
            HttpRequest::builder()
                .uri(format!("/api/v1/e2ee/users/{}", owner.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = socket.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(socket, router).await.unwrap();
    });
    let native = rv_client::NativeClient::new(&format!("http://{address}")).unwrap();
    native.update_token(token.clone());
    let receipt = native
        .register_crypto_device(&first.registration)
        .await
        .unwrap();
    let catalog = native.crypto_directory(&owner.id, None).await.unwrap();
    assert_eq!(catalog.devices.len(), 1);
    let uploaded = native
        .publish_key_packages(&packages(&first, &receipt.device_revision, 2))
        .await
        .unwrap();
    assert_eq!(uploaded.key_package_refs.len(), 2);
    assert_eq!(
        serde_json::to_value(
            native
                .crypto_operation(&receipt.operation_id)
                .await
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&receipt).unwrap()
    );
    let response = reqwest::Client::new()
        .get(format!("http://{address}/api/v1/e2ee/users/{}", owner.id))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
    response.bytes().await.unwrap();
    let mut large = packages(&first, "1", 1);
    large.packages = vec![B64.encode(&vec![1; PACKAGE_BYTES]); 8];
    let response = reqwest::Client::new()
        .post(format!("http://{address}/api/v1/e2ee/key-packages"))
        .bearer_auth(&token)
        .json(&large)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 400); // Per-route 256KiB limit, then actual proof validation.
    let response = reqwest::Client::new()
        .post(format!("http://{address}/api/v1/e2ee/key-packages"))
        .bearer_auth(&token)
        .header("content-type", "application/json")
        .body(vec![b'x'; 256 * 1024 + 1])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 413);
    task.abort();
}
