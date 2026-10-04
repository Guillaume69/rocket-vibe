use super::*;
use crate::{e2ee::groups as delivery, store};
use axum::{body::to_bytes, response::Response};
use openmls::prelude::{
    GroupId, LeafNodeIndex, MlsGroup, MlsGroupCreateConfig, MlsGroupJoinConfig, MlsMessageBodyIn,
    MlsMessageIn, ProcessedMessageContent, StagedWelcome,
};
use rv_crypto_public::Fingerprint;
use rv_crypto_public::groups::{self as public, Member, Participant, Plan, Transition};
use rv_protocol::{CreateRoom, Room, SendMessage};
use serde::de::DeserializeOwned;
use std::time::Duration;

#[path = "roster_tests.rs"]
mod roster_observation;

#[path = "protected_worker_tests.rs"]
mod protected_worker;

#[path = "application_tests.rs"]
mod application_delivery;

struct Ready {
    actor: Account,
    token: String,
    client: Client,
    provider: OpenMlsRustCrypto,
    revision: String,
}
impl Ready {
    fn credential(&self) -> CredentialWithKey {
        CredentialWithKey {
            credential: self.client.certificate.credential().unwrap(),
            signature_key: self.client.leaf.to_public_vec().into(),
        }
    }
    fn participant(&self, leaf: u32, reference: Option<Fingerprint>) -> Participant {
        Participant {
            user: self.actor.id.clone(),
            device: self.client.certificate.device.device.clone(),
            incarnation: self.client.certificate.device.incarnation,
            root: self.client.root.fingerprint().unwrap(),
            certificate: self.client.certificate.fingerprint().unwrap(),
            leaf,
            key_package: reference,
        }
    }
    fn scope(&self, room: &Room) -> public::Scope {
        public::Scope {
            instance: self.client.root.instance.clone(),
            data_epoch: self.client.registration.scope.data_epoch.clone(),
            room: room.id.clone(),
            incarnation: random_bytes(),
        }
    }
    fn group(&self, scope: &public::Scope) -> MlsGroup {
        MlsGroup::new_with_group_id(
            &self.provider,
            &self.client.leaf,
            &MlsGroupCreateConfig::builder()
                .ciphersuite(SUITE)
                .use_ratchet_tree_extension(true)
                .build(),
            GroupId::from_slice(&scope.group_id().unwrap()),
            self.credential(),
        )
        .unwrap()
    }
    async fn package(&self, app: &App) -> (KeyPackage, Fingerprint) {
        let package = KeyPackage::builder()
            .build(SUITE, &self.provider, &self.client.leaf, self.credential())
            .unwrap();
        let receipt = publish(
            app,
            &self.actor,
            wire::PublishKeyPackages {
                scope: self.client.registration.scope.clone(),
                operation_id: auth::random_token(),
                device_revision: self.revision.clone(),
                packages: vec![
                    B64.encode(&package.key_package().tls_serialize_detached().unwrap()),
                ],
            },
        )
        .await
        .unwrap();
        let reference = B64
            .decode(receipt.key_package_refs[0].as_bytes())
            .unwrap()
            .try_into()
            .unwrap();
        (package.key_package().clone(), reference)
    }
}
async fn ready(app: &App, name: &str) -> Ready {
    let (actor, token) = actor(app, name).await;
    let client = client(app, &actor, None).await;
    let receipt = register(app, &actor, client.registration.clone())
        .await
        .unwrap();
    let provider = OpenMlsRustCrypto::default();
    client.leaf.store(provider.storage()).unwrap();
    Ready {
        actor,
        token,
        client,
        provider,
        revision: receipt.device_revision,
    }
}
async fn room(app: &App, owner: &Ready, guest: Option<&Ready>) -> Room {
    let room = store::create_room(
        app,
        &owner.actor,
        CreateRoom {
            name: format!("crypto-{}", auth::random_token()),
            private: true,
            operation_id: None,
        },
    )
    .await
    .unwrap();
    if let Some(guest) = guest {
        store::membership(app, &owner.actor, &room.id, &guest.actor.id, false)
            .await
            .unwrap();
    }
    room
}
fn digest(bytes: &[u8]) -> Fingerprint {
    data_encoding::HEXLOWER
        .decode(auth::hash_token_bytes(bytes).as_bytes())
        .unwrap()
        .try_into()
        .unwrap()
}
struct Prepared {
    scope: public::Scope,
    epoch: u64,
    context: Fingerprint,
    tree: Vec<u8>,
    participants: Vec<Participant>,
    commit: Option<Vec<u8>>,
    welcomes: Vec<wire::GroupWelcome>,
    previous: Option<wire::GroupReceipt>,
}
impl Prepared {
    fn from_group(group: &MlsGroup, owner: &Ready, scope: public::Scope) -> Self {
        let (context, tree) = match group.pending_commit() {
            Some(pending) => (
                pending.group_context(),
                pending
                    .export_ratchet_tree(owner.provider.crypto(), group.export_ratchet_tree())
                    .unwrap()
                    .unwrap(),
            ),
            None => (
                group.public_group().group_context(),
                group.export_ratchet_tree(),
            ),
        };
        Self {
            scope,
            epoch: context.epoch().as_u64(),
            context: digest(&context.tls_serialize_detached().unwrap()),
            tree: tree.tls_serialize_detached().unwrap(),
            participants: vec![owner.participant(0, None)],
            commit: None,
            welcomes: vec![],
            previous: None,
        }
    }
}
async fn signed(
    app: &App,
    owner: &Ready,
    mut prepared: Prepared,
) -> (Transition, wire::GroupSubmission) {
    let authority: String = sqlx::query_scalar("SELECT authority_version FROM rooms WHERE id=$1")
        .bind(&prepared.scope.room)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    let rows:Vec<(String,String,String)>=sqlx::query_as("SELECT m.user_id,m.access_version,u.activation_version FROM members m JOIN users u ON u.id=m.user_id WHERE m.room_id=$1 AND NOT u.disabled ORDER BY m.user_id")
        .bind(&prepared.scope.room).fetch_all(&app.pool).await.unwrap();
    prepared
        .welcomes
        .sort_by(|a, b| a.device_id.cmp(&b.device_id));
    let plan = Plan {
        version: 1,
        scope: prepared.scope,
        operation: auth::random_token(),
        expected_revision: prepared
            .previous
            .as_ref()
            .map_or(0, |r| r.revision.parse().unwrap()),
        expected_epoch: prepared.previous.as_ref().map(|r| r.epoch.parse().unwrap()),
        epoch: prepared.epoch,
        previous: prepared.previous.as_ref().map_or([0; 32], |r| {
            data_encoding::HEXLOWER
                .decode(r.fingerprint.as_bytes())
                .unwrap()
                .try_into()
                .unwrap()
        }),
        authority_version: authority,
        members: rows
            .into_iter()
            .map(|(user, access_version, activation_version)| Member {
                user,
                access_version,
                activation_version,
            })
            .collect(),
        participants: prepared.participants,
        context: prepared.context,
        commit: prepared.commit.as_deref().map(digest),
        tree: digest(&prepared.tree),
        welcomes: prepared
            .welcomes
            .iter()
            .map(|w| public::Welcome {
                device: w.device_id.clone(),
                incarnation: data_encoding::HEXLOWER
                    .decode(w.incarnation.as_bytes())
                    .unwrap()
                    .try_into()
                    .unwrap(),
                key_package: B64
                    .decode(w.key_package_ref.as_bytes())
                    .unwrap()
                    .try_into()
                    .unwrap(),
                digest: digest(&B64.decode(w.payload.as_bytes()).unwrap()),
            })
            .collect(),
    };
    let transition = Transition {
        certificate: owner.client.certificate.clone(),
        signature: owner
            .client
            .leaf
            .sign(&plan.signing_bytes().unwrap())
            .unwrap(),
        plan,
    };
    let input = wire::GroupSubmission {
        scope: owner.client.registration.scope.clone(),
        operation_id: transition.plan.operation.clone(),
        transition: B64.encode(&transition.to_bytes().unwrap()),
        commit: prepared.commit.as_ref().map(|b| B64.encode(b)),
        tree: B64.encode(&prepared.tree),
        welcomes: prepared.welcomes,
    };
    (transition, input)
}
async fn add(
    app: &App,
    owner: &Ready,
    guest: &Ready,
    room: &Room,
) -> (MlsGroup, Transition, wire::GroupSubmission) {
    let scope = owner.scope(room);
    let mut group = owner.group(&scope);
    let (package, reference) = guest.package(app).await;
    let (commit, welcome, _) = group
        .add_members(&owner.provider, &owner.client.leaf, &[package])
        .unwrap();
    let mut prepared = Prepared::from_group(&group, owner, scope);
    prepared
        .participants
        .push(guest.participant(1, Some(reference)));
    prepared.commit = Some(commit.to_bytes().unwrap());
    prepared.welcomes.push(wire::GroupWelcome {
        device_id: guest.client.certificate.device.device.clone(),
        incarnation: hex(&guest.client.certificate.device.incarnation),
        key_package_ref: B64.encode(&reference),
        payload: B64.encode(&welcome.to_bytes().unwrap()),
    });
    let (transition, input) = signed(app, owner, prepared).await;
    (group, transition, input)
}
async fn body<T: DeserializeOwned>(response: Response) -> T {
    serde_json::from_slice(
        &to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap()
}
fn plaintext() -> SendMessage {
    SendMessage {
        operation_id: auth::random_token(),
        text: "must stay on the client".into(),
        quotes: vec![],
        reply_to: None,
        cards: vec![],
    }
}

#[sqlx::test]
async fn actual_mls_welcome_is_atomic_targeted_durable_and_admission_is_single_use(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "group-owner").await;
    let guest = ready(&app, "group-guest").await;
    let room = room(&app, &owner, Some(&guest)).await;
    let (mut group, transition, input) = add(&app, &owner, &guest, &room).await;
    let package_bytes: Vec<u8> =
        sqlx::query_scalar("SELECT wire FROM e2ee_key_packages WHERE reference=$1")
            .bind(&input.welcomes[0].key_package_ref)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(
        group.epoch().as_u64(),
        0,
        "local state stays pending until acknowledgement"
    );
    let mut tampered = input.clone();
    tampered.welcomes[0].payload = B64.encode(b"substituted Welcome");
    rejected(
        delivery::submit(&app, &owner.actor, &room.id, tampered).await,
        "crypto_proof_invalid",
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_groups")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let spent: bool = sqlx::query_scalar("SELECT spent FROM e2ee_key_packages WHERE reference=$1")
        .bind(&input.welcomes[0].key_package_ref)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert!(!spent);
    let receipt = delivery::submit(&app, &owner.actor, &room.id, input.clone())
        .await
        .unwrap();
    assert_eq!(receipt.epoch, "1");
    assert_eq!(receipt.revision, "1");
    let retry = delivery::submit(&app, &owner.actor, &room.id, input.clone())
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&receipt).unwrap(),
        serde_json::to_value(retry).unwrap()
    );
    let row: (bool, Option<Vec<u8>>, String) = sqlx::query_as(
        "SELECT spent,wire,consumed_operation FROM e2ee_key_packages WHERE reference=$1",
    )
    .bind(&input.welcomes[0].key_package_ref)
    .fetch_one(&app.pool)
    .await
    .unwrap();
    assert!(row.0);
    assert!(row.1.is_none());
    assert_eq!(row.2, input.operation_id);
    let alice_events: wire::GroupEventPage = body(
        delivery::events(&app, &owner.actor, &room.id, Some("0"))
            .await
            .unwrap(),
    )
    .await;
    assert!(alice_events.events[0].welcome.is_none());
    let bob_events: wire::GroupEventPage = body(
        delivery::events(&app, &guest.actor, &room.id, Some("0"))
            .await
            .unwrap(),
    )
    .await;
    let welcome = bob_events.events[0].welcome.as_ref().unwrap();
    let message =
        MlsMessageIn::tls_deserialize_exact(B64.decode(welcome.payload.as_bytes()).unwrap())
            .unwrap();
    let MlsMessageBodyIn::Welcome(welcome) = message.extract() else {
        panic!("expected MLS Welcome")
    };
    let mut joined = StagedWelcome::new_from_welcome(
        &guest.provider,
        &MlsGroupJoinConfig::default(),
        welcome,
        None,
    )
    .unwrap()
    .into_group(&guest.provider)
    .unwrap();
    assert_eq!(
        digest(
            &joined
                .public_group()
                .group_context()
                .tls_serialize_detached()
                .unwrap()
        ),
        transition.plan.context
    );
    assert_eq!(
        digest(
            &joined
                .export_ratchet_tree()
                .tls_serialize_detached()
                .unwrap()
        ),
        transition.plan.tree
    );
    assert_eq!(
        joined.group_id().as_slice(),
        transition.plan.scope.group_id().unwrap()
    );
    group.merge_pending_commit(&owner.provider).unwrap();
    let private = b"actual private text after server admission";
    let encrypted = group
        .create_message(&owner.provider, &owner.client.leaf, private)
        .unwrap()
        .to_bytes()
        .unwrap();
    assert!(!encrypted.windows(private.len()).any(|b| b == private));
    let protocol = MlsMessageIn::tls_deserialize_exact(encrypted)
        .unwrap()
        .try_into_protocol_message()
        .unwrap();
    let ProcessedMessageContent::ApplicationMessage(opened) = joined
        .process_message(&guest.provider, protocol)
        .unwrap()
        .into_content()
    else {
        panic!("expected application message")
    };
    assert_eq!(opened.into_bytes(), private);
    rejected(
        store::send(&app, &owner.actor, &room.id, plaintext()).await,
        "crypto_required",
    );
    let state: wire::GroupState =
        body(delivery::state(&app, &owner.actor, &room.id).await.unwrap()).await;
    assert!(!state.needs_rekey);
    let restarted = App::from_pool(app.pool.clone()).await.unwrap();
    let recovered: wire::GroupReceipt = body(
        delivery::operation(&restarted, &owner.actor, &room.id, &input.operation_id)
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(recovered.fingerprint, receipt.fingerprint);
    let mut changed = input.clone();
    changed.tree = B64.encode(b"changed retry");
    rejected(
        delivery::submit(&app, &owner.actor, &room.id, changed).await,
        "operation_conflict",
    );
    let other_room = store::create_room(
        &app,
        &owner.actor,
        CreateRoom {
            name: "different-room".into(),
            private: true,
            operation_id: None,
        },
    )
    .await
    .unwrap();
    store::membership(&app, &owner.actor, &other_room.id, &guest.actor.id, false)
        .await
        .unwrap();
    let scope = owner.scope(&other_room);
    let mut second_group = owner.group(&scope);
    let package = KeyPackageIn::tls_deserialize_exact(package_bytes)
        .unwrap()
        .validate(owner.provider.crypto(), ProtocolVersion::Mls10)
        .unwrap();
    let (commit, welcome, _) = second_group
        .add_members(&owner.provider, &owner.client.leaf, &[package])
        .unwrap();
    let reference = B64
        .decode(input.welcomes[0].key_package_ref.as_bytes())
        .unwrap()
        .try_into()
        .unwrap();
    let mut prepared = Prepared::from_group(&second_group, &owner, scope);
    prepared
        .participants
        .push(guest.participant(1, Some(reference)));
    prepared.commit = Some(commit.to_bytes().unwrap());
    prepared.welcomes.push(wire::GroupWelcome {
        payload: B64.encode(&welcome.to_bytes().unwrap()),
        ..input.welcomes[0].clone()
    });
    let (_, reuse) = signed(&app, &owner, prepared).await;
    rejected(
        delivery::submit(&app, &owner.actor, &other_room.id, reuse).await,
        "crypto_key_package_spent",
    );
}

#[sqlx::test]
async fn room_leave_and_rejoin_invalidates_old_admission_even_with_identical_roster(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "aba-owner").await;
    let guest = ready(&app, "aba-guest").await;
    let room = room(&app, &owner, Some(&guest)).await;
    let (mut group, transition, input) = add(&app, &owner, &guest, &room).await;
    let receipt = delivery::submit(&app, &owner.actor, &room.id, input)
        .await
        .unwrap();
    group.merge_pending_commit(&owner.provider).unwrap();
    store::membership(&app, &owner.actor, &room.id, &guest.actor.id, true)
        .await
        .unwrap();
    rejected(
        delivery::state(&app, &guest.actor, &room.id).await,
        "not_found",
    );
    store::membership(&app, &owner.actor, &room.id, &guest.actor.id, false)
        .await
        .unwrap();
    rejected(
        delivery::events(&app, &guest.actor, &room.id, Some("0")).await,
        "crypto_device_revoked",
    );
    let state: wire::GroupState =
        body(delivery::state(&app, &owner.actor, &room.id).await.unwrap()).await;
    assert!(state.needs_rekey);
    let (commit, _, _) = group
        .self_update(&owner.provider, &owner.client.leaf, Default::default())
        .unwrap()
        .into_messages();
    let mut prepared = Prepared::from_group(&group, &owner, transition.plan.scope.clone());
    prepared.participants = transition.plan.participants;
    prepared.previous = Some(receipt);
    prepared.commit = Some(commit.to_bytes().unwrap());
    let (_, stale) = signed(&app, &owner, prepared).await;
    rejected(
        delivery::submit(&app, &owner.actor, &room.id, stale).await,
        "crypto_key_package_spent",
    );
}

#[sqlx::test]
async fn actual_remove_commit_replaces_roster_and_conflicting_parent_is_rejected(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "remove-owner").await;
    let guest = ready(&app, "remove-guest").await;
    let room = room(&app, &owner, Some(&guest)).await;
    let (mut group, transition, input) = add(&app, &owner, &guest, &room).await;
    let receipt = delivery::submit(&app, &owner.actor, &room.id, input)
        .await
        .unwrap();
    group.merge_pending_commit(&owner.provider).unwrap();
    store::membership(&app, &owner.actor, &room.id, &guest.actor.id, true)
        .await
        .unwrap();
    let state: wire::GroupState =
        body(delivery::state(&app, &owner.actor, &room.id).await.unwrap()).await;
    assert!(state.needs_rekey);
    let (commit, _, _) = group
        .remove_members(
            &owner.provider,
            &owner.client.leaf,
            &[LeafNodeIndex::new(1)],
        )
        .unwrap();
    let mut prepared = Prepared::from_group(&group, &owner, transition.plan.scope);
    prepared.commit = Some(commit.to_bytes().unwrap());
    prepared.previous = Some(receipt);
    let (good, input) = signed(&app, &owner, prepared).await;
    let mut bad = good.clone();
    bad.plan.previous = [9; 32];
    bad.signature = owner
        .client
        .leaf
        .sign(&bad.plan.signing_bytes().unwrap())
        .unwrap();
    let mut changed = input.clone();
    changed.operation_id = bad.plan.operation.clone();
    changed.transition = B64.encode(&bad.to_bytes().unwrap());
    rejected(
        delivery::submit(&app, &owner.actor, &room.id, changed).await,
        "crypto_group_changed",
    );
    let next = delivery::submit(&app, &owner.actor, &room.id, input)
        .await
        .unwrap();
    assert_eq!(next.revision, "2");
    assert_eq!(next.epoch, "2");
    group.merge_pending_commit(&owner.provider).unwrap();
    assert_eq!(group.members().count(), 1);
    let state: wire::GroupState =
        body(delivery::state(&app, &owner.actor, &room.id).await.unwrap()).await;
    assert!(!state.needs_rekey);
    rejected(
        delivery::events(&app, &guest.actor, &room.id, Some("0")).await,
        "not_found",
    );
}

#[sqlx::test]
async fn genesis_and_concurrent_commands_bind_current_session_and_empty_history(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "genesis-owner").await;
    let room = room(&app, &owner, None).await;
    let scope = owner.scope(&room);
    let group = owner.group(&scope);
    let (_, input) = signed(&app, &owner, Prepared::from_group(&group, &owner, scope)).await;
    let (first, second) = tokio::join!(
        delivery::submit(&app, &owner.actor, &room.id, input.clone()),
        delivery::submit(&app, &owner.actor, &room.id, input.clone())
    );
    assert_eq!(first.unwrap().fingerprint, second.unwrap().fingerprint);
    let state: wire::GroupState =
        body(delivery::state(&app, &owner.actor, &room.id).await.unwrap()).await;
    assert_eq!(state.receipt.epoch, "0");
    let (other_actor, _) = login(&app, "genesis-owner").await;
    let other_client = client(
        &app,
        &other_actor,
        Some((owner.client.root.clone(), owner.client.signing.clone())),
    )
    .await;
    let mut registration = other_client.registration.clone();
    registration.expected_root_fingerprint = Some(hex(&owner.client.root.fingerprint().unwrap()));
    register(&app, &other_actor, registration).await.unwrap();
    rejected(
        delivery::state(&app, &other_actor, &room.id).await,
        "permission_denied",
    );
    let new_room = store::create_room(
        &app,
        &owner.actor,
        CreateRoom {
            name: "plain-history".into(),
            private: true,
            operation_id: None,
        },
    )
    .await
    .unwrap();
    store::send(&app, &owner.actor, &new_room.id, plaintext())
        .await
        .unwrap();
    let scope = owner.scope(&new_room);
    let group = owner.group(&scope);
    let (_, input) = signed(&app, &owner, Prepared::from_group(&group, &owner, scope)).await;
    rejected(
        delivery::submit(&app, &owner.actor, &new_room.id, input).await,
        "crypto_room_has_history",
    );
}

#[sqlx::test]
async fn locked_recipient_fence_revalidates_head_after_wait_without_claiming_package(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "fence-owner").await;
    let guest = ready(&app, "fence-guest").await;
    let room = room(&app, &owner, Some(&guest)).await;
    let (_, _, input) = add(&app, &owner, &guest, &room).await;
    let mut retirement = app.pool.begin().await.unwrap();
    sqlx::query("UPDATE e2ee_devices SET expires_at=0 WHERE device_id=$1")
        .bind(&guest.client.certificate.device.device)
        .execute(&mut *retirement)
        .await
        .unwrap();
    let task = tokio::spawn({
        let app = app.clone();
        let actor = owner.actor.clone();
        let room = room.id.clone();
        let input = input.clone();
        async move { delivery::submit(&app, &actor, &room, input).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !task.is_finished(),
        "recipient fence serializes admission with retirement"
    );
    retirement.commit().await.unwrap();
    rejected(
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap(),
        "crypto_rekey_required",
    );
    let spent: bool = sqlx::query_scalar("SELECT spent FROM e2ee_key_packages WHERE reference=$1")
        .bind(&input.welcomes[0].key_package_ref)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert!(!spent);
}

#[sqlx::test]
async fn stalled_group_response_holds_session_until_flush_and_expiry_refuses_body(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "lease-owner").await;
    let guest = ready(&app, "lease-guest").await;
    let room = room(&app, &owner, Some(&guest)).await;
    let (_, _, input) = add(&app, &owner, &guest, &room).await;
    delivery::submit(&app, &owner.actor, &room.id, input)
        .await
        .unwrap();
    let response = delivery::events(&app, &guest.actor, &room.id, Some("0"))
        .await
        .unwrap();
    let task = tokio::spawn({
        let app = app.clone();
        let actor = guest.actor.clone();
        async move { crate::sessions::revoke(&app, &actor, None).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!task.is_finished());
    let _: wire::GroupEventPage = body(response).await;
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let state: wire::GroupState =
        body(delivery::state(&app, &owner.actor, &room.id).await.unwrap()).await;
    assert!(state.needs_rekey);
    sqlx::query("UPDATE sessions SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE token_hash=$1").bind(&owner.actor.session_hash).execute(&app.pool).await.unwrap();
    let response = delivery::state(&app, &owner.actor, &room.id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .is_err(),
        "no group payload after the session deadline"
    );
}

#[sqlx::test]
async fn http_and_rust_sdk_deliver_private_group_routes_without_cache_or_foreign_receipt(
    pool: PgPool,
) {
    use axum::{body::Body, http::Request as HttpRequest};
    use tower::ServiceExt;
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "http-group-owner").await;
    let guest = ready(&app, "http-group-guest").await;
    let room = room(&app, &owner, Some(&guest)).await;
    let (_, mut transition, mut input) = add(&app, &owner, &guest, &room).await;
    let router = crate::http::router(app.clone());
    let anonymous = router
        .clone()
        .oneshot(
            HttpRequest::builder()
                .uri(format!("/api/v1/e2ee/rooms/{}/roster", room.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(anonymous.headers()["cache-control"], "no-store");
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = socket.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(socket, router).await.unwrap() });
    let native = rv_client::NativeClient::new(&format!("http://{address}")).unwrap();
    native.update_token(owner.token.clone());
    let package = native
        .available_crypto_key_package(
            &room.id,
            &guest.actor.id,
            &guest.client.certificate.device.device,
        )
        .await
        .unwrap();
    assert_eq!(package.reference, input.welcomes[0].key_package_ref);
    // Build the signed policy from the actual authorized SDK observation;
    // clients must not need the fixture's privileged SQL access to submit it.
    let observed = native.crypto_group_roster(&room.id).await.unwrap();
    assert!(observed.group.is_none());
    assert_eq!(observed.members.len(), 2);
    transition.plan.authority_version = observed.authority_version;
    transition.plan.members = observed
        .members
        .into_iter()
        .map(|m| Member {
            user: m.user_id,
            access_version: m.access_version,
            activation_version: m.activation_version,
        })
        .collect();
    transition.signature = owner
        .client
        .leaf
        .sign(&transition.plan.signing_bytes().unwrap())
        .unwrap();
    input.transition = B64.encode(&transition.to_bytes().unwrap());
    let receipt = native.submit_crypto_group(&room.id, &input).await.unwrap();
    assert_eq!(
        native
            .crypto_group_roster(&room.id)
            .await
            .unwrap()
            .group
            .unwrap()
            .fingerprint,
        receipt.fingerprint
    );
    assert_eq!(
        native
            .submit_crypto_group(&room.id, &input)
            .await
            .unwrap()
            .fingerprint,
        receipt.fingerprint
    );
    assert_eq!(
        native
            .crypto_group_operation(&room.id, &input.operation_id)
            .await
            .unwrap()
            .fingerprint,
        receipt.fingerprint
    );
    assert!(
        !native
            .crypto_group_state(&room.id)
            .await
            .unwrap()
            .needs_rekey
    );
    assert!(
        native
            .crypto_group_events(&room.id, "0")
            .await
            .unwrap()
            .events[0]
            .welcome
            .is_none()
    );
    native.update_token(guest.token.clone());
    assert!(
        native
            .crypto_group_events(&room.id, "0")
            .await
            .unwrap()
            .events[0]
            .welcome
            .is_some()
    );
    assert!(matches!(
        native
            .crypto_group_operation(&room.id, &input.operation_id)
            .await,
        Err(rv_client::Error::Server { status: 404, .. })
    ));
    let http = reqwest::Client::new();
    let observation = http
        .get(format!(
            "http://{address}/api/v1/e2ee/rooms/{}/roster",
            room.id
        ))
        .bearer_auth(&guest.token)
        .send()
        .await
        .unwrap();
    assert_eq!(observation.status().as_u16(), 200);
    assert_eq!(observation.headers()["cache-control"], "no-store");
    assert_eq!(
        observation
            .json::<wire::GroupRoster>()
            .await
            .unwrap()
            .group
            .unwrap()
            .fingerprint,
        receipt.fingerprint
    );
    let response = http
        .get(format!(
            "http://{address}/api/v1/e2ee/rooms/{}/events?after=01",
            room.id
        ))
        .bearer_auth(&guest.token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 400);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let response = http
        .post(format!(
            "http://{address}/api/v1/e2ee/rooms/{}/transitions",
            room.id
        ))
        .bearer_auth(&owner.token)
        .header("content-type", "application/json")
        .body("x".repeat(4 * 1024 * 1024 + 1))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 413);
    assert_eq!(response.headers()["cache-control"], "no-store");
    server.abort();
}

#[sqlx::test]
async fn outstanding_plain_upload_blocks_genesis_then_group_blocks_new_clear_file(pool: PgPool) {
    let root = std::env::temp_dir().join(format!("rv-group-uploads-{}", auth::random_token()));
    let app = App::from_pool(pool)
        .await
        .unwrap()
        .with_objects(crate::objects::LocalObjects::open(&root).unwrap());
    let owner = ready(&app, "upload-group-owner").await;
    let room = room(&app, &owner, None).await;
    let scope = owner.scope(&room);
    let group = owner.group(&scope);
    let upload:rv_protocol::parity::PrepareUpload=serde_json::from_value(serde_json::json!({"operation_id":auth::random_token(),"room_id":room.id,"bytes":"1","sha256":auth::hash_token_bytes(b"x"),"media_type":"text/plain","filename":"plain.txt","encrypted":false})).unwrap();
    let reservation = crate::files::prepare(&app, &owner.actor, upload.clone())
        .await
        .unwrap();
    let (_, input) = signed(&app, &owner, Prepared::from_group(&group, &owner, scope)).await;
    rejected(
        delivery::submit(&app, &owner.actor, &room.id, input.clone()).await,
        "crypto_room_has_history",
    );
    crate::files::cancel(&app, &owner.actor, &reservation.id)
        .await
        .unwrap();
    delivery::submit(&app, &owner.actor, &room.id, input)
        .await
        .unwrap();
    let mut next = upload;
    next.operation_id = auth::random_token();
    rejected(
        crate::files::prepare(&app, &owner.actor, next).await,
        "crypto_required",
    );
    std::fs::remove_dir_all(root).unwrap();
}
