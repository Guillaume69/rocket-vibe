use super::*;
use delivery::messages;
use rv_crypto_public::messages as packet;
#[path = "settlement_tests.rs"]
mod settlements;

#[sqlx::test]
async fn ordinary_quotes_require_private_delivery_access_and_expose_only_references(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "mixed-quote-owner").await;
    let guest = ready(&app, "mixed-quote-guest").await;
    let source = room(&app, &owner, None).await;
    let destination = room(&app, &owner, Some(&guest)).await;
    let (mut group, transition, group_receipt) = genesis(&app, &owner, &source).await;
    let private = plaintext();
    let packet = encrypted(
        &owner,
        &mut group,
        &transition.plan.scope,
        &group_receipt,
        &private,
    );
    let receipt = messages::submit(&app, &owner.actor, &source.id, packet)
        .await
        .unwrap();
    let input = SendMessage {
        operation_id: "ordinary-private-quote".into(),
        text: String::new(),
        reply_to: None,
        cards: vec![],
        quotes: vec![rv_protocol::parity::QuoteReference {
            room_id: source.id.clone(),
            message_id: receipt.message_id.clone(),
            revision: receipt.position.clone(),
        }],
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = crate::http::router(app.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let native = rv_client::NativeClient::new(&format!("http://{address}")).unwrap();
    native.update_token(owner.token.clone());
    let quoted = native.send(&destination.id, &input).await.unwrap();
    assert_eq!(quoted.text, "");
    assert_eq!(quoted.quotes[0].reference, input.quotes[0]);
    assert!(quoted.quotes[0].excerpt.is_none());
    assert!(quoted.quotes[0].source_membership_version.is_some());
    let encoded = serde_json::to_string(&quoted).unwrap();
    assert!(!encoded.contains(&private.text));
    let mut stale = input.clone();
    stale.operation_id = "stale-private-quote".into();
    stale.quotes[0].revision = "1".into();
    assert!(
        native
            .send(&destination.id, &stale)
            .await
            .unwrap_err()
            .to_string()
            .contains("quote_revision_conflict")
    );
    // Joining the domain after publication gives no historical MLS admission.
    store::membership(&app, &owner.actor, &source.id, &guest.actor.id, false)
        .await
        .unwrap();
    native.update_token(guest.token.clone());
    let mut guest_input = input.clone();
    guest_input.operation_id = "unadmitted-private-quote".into();
    assert!(native.send(&destination.id, &guest_input).await.is_err());
    let visible = native.message(&quoted.id).await.unwrap();
    assert_eq!(visible.quotes[0].reference, input.quotes[0]);
    assert!(visible.quotes[0].excerpt.is_none());
    assert!(
        !serde_json::to_string(&visible)
            .unwrap()
            .contains(&private.text)
    );
    native.update_token(owner.token.clone());
    // An accepted intention stays recoverable after certificate expiry. A new
    // intention must pass the current private reader gate again.
    sqlx::query("UPDATE e2ee_devices SET expires_at=1 WHERE user_id=$1")
        .bind(&owner.actor.id)
        .execute(&app.pool)
        .await
        .unwrap();
    assert_eq!(
        native.send(&destination.id, &input).await.unwrap().id,
        quoted.id
    );
    let mut expired = input;
    expired.operation_id = "expired-private-quote".into();
    assert!(native.send(&destination.id, &expired).await.is_err());
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM messages WHERE room_id=$1 AND system IS NULL")
            .bind(&destination.id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
    server.abort();
}

async fn genesis(
    app: &App,
    owner: &Ready,
    room: &Room,
) -> (MlsGroup, Transition, wire::GroupReceipt) {
    let scope = owner.scope(room);
    let group = owner.group(&scope);
    let (transition, input) = signed(app, owner, Prepared::from_group(&group, owner, scope)).await;
    let receipt = delivery::submit(app, &owner.actor, &room.id, input)
        .await
        .unwrap();
    (group, transition, receipt)
}
fn encrypted(
    owner: &Ready,
    group: &mut MlsGroup,
    scope: &public::Scope,
    receipt: &wire::GroupReceipt,
    message: &SendMessage,
) -> wire::ApplicationSubmission {
    encrypted_as(
        owner,
        group,
        scope,
        receipt,
        message,
        packet::Kind::Chat,
        None,
    )
}
/// An edit or deletion of `target` (E2EE_AMENDMENTS.md), or a chat message.
fn encrypted_as(
    owner: &Ready,
    group: &mut MlsGroup,
    scope: &public::Scope,
    receipt: &wire::GroupReceipt,
    message: &SendMessage,
    kind: packet::Kind,
    target: Option<String>,
) -> wire::ApplicationSubmission {
    #[derive(serde::Serialize)]
    struct Payload<'a> {
        version: u8,
        message: &'a SendMessage,
    }
    let header = packet::Header {
        version: 1,
        scope: scope.clone(),
        operation: message.operation_id.clone(),
        group_revision: receipt.revision.parse().unwrap(),
        epoch: receipt.epoch.parse().unwrap(),
        group_fingerprint: data_encoding::HEXLOWER
            .decode(receipt.fingerprint.as_bytes())
            .unwrap()
            .try_into()
            .unwrap(),
        author: owner.actor.id.clone(),
        device: owner.client.certificate.device.device.clone(),
        incarnation: owner.client.certificate.device.incarnation,
        certificate: owner.client.certificate.fingerprint().unwrap(),
        kind,
        thread: message.reply_to.clone(),
        target,
    };
    group.set_aad(header.aad().unwrap());
    let plaintext = serde_json::to_vec(&Payload {
        version: 1,
        message,
    })
    .unwrap();
    let ciphertext = group
        .create_message(&owner.provider, &owner.client.leaf, &plaintext)
        .unwrap()
        .to_bytes()
        .unwrap();
    let mut proof = packet::Proof {
        header,
        certificate: owner.client.certificate.clone(),
        ciphertext: digest(&ciphertext),
        signature: vec![],
    };
    proof.signature = owner
        .client
        .leaf
        .sign(&proof.signing_bytes().unwrap())
        .unwrap();
    proof
        .verify(Utc::now().timestamp() as u64, &ciphertext)
        .unwrap();
    wire::ApplicationSubmission {
        scope: owner.client.registration.scope.clone(),
        operation_id: message.operation_id.clone(),
        proof: B64.encode(&proof.to_bytes().unwrap()),
        ciphertext: B64.encode(&ciphertext),
    }
}
fn join(guest: &Ready, welcome: &wire::GroupWelcome) -> MlsGroup {
    let message =
        MlsMessageIn::tls_deserialize_exact(B64.decode(welcome.payload.as_bytes()).unwrap())
            .unwrap();
    let MlsMessageBodyIn::Welcome(welcome) = message.extract() else {
        panic!("expected Welcome")
    };
    StagedWelcome::new_from_welcome(
        &guest.provider,
        &MlsGroupJoinConfig::default(),
        welcome,
        None,
    )
    .unwrap()
    .into_group(&guest.provider)
    .unwrap()
}
async fn page(app: &App, reader: &Ready, room: &Room) -> wire::DeliveryPage {
    body(
        messages::delivery(app, &reader.actor, &room.id, None, None)
            .await
            .unwrap(),
    )
    .await
}
async fn rotate(
    app: &App,
    owner: &Ready,
    group: &mut MlsGroup,
    transition: &Transition,
    previous: wire::GroupReceipt,
) -> (Transition, wire::GroupReceipt) {
    let (commit, _, _) = group
        .self_update(&owner.provider, &owner.client.leaf, Default::default())
        .unwrap()
        .into_messages();
    let mut prepared = Prepared::from_group(group, owner, transition.plan.scope.clone());
    prepared.participants = transition.plan.participants.clone();
    prepared.previous = Some(previous);
    prepared.commit = Some(commit.to_bytes().unwrap());
    let (transition, input) = signed(app, owner, prepared).await;
    let receipt = delivery::submit(app, &owner.actor, &transition.plan.scope.room, input)
        .await
        .unwrap();
    group.merge_pending_commit(&owner.provider).unwrap();
    (transition, receipt)
}

#[sqlx::test]
async fn http_exact_retries_survive_restart_and_only_a_real_peer_opens_the_opaque_body(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "application-http-owner").await;
    let guest = ready(&app, "application-http-guest").await;
    let room = room(&app, &owner, Some(&guest)).await;
    sqlx::query("UPDATE instance SET position=9007199254740992 WHERE singleton")
        .execute(&app.pool)
        .await
        .unwrap();
    let (mut group, transition, input) = add(&app, &owner, &guest, &room).await;
    let router = crate::http::router(app.clone());
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = socket.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(socket, router).await.unwrap() });
    let native = rv_client::NativeClient::new(&format!("http://{address}")).unwrap();
    native.update_token(owner.token.clone());
    let ordinary_before = native.snapshot().await.unwrap();
    assert!(
        !ordinary_before
            .rooms
            .iter()
            .find(|r| r.id == room.id)
            .unwrap()
            .encrypted
    );
    let receipt = native.submit_crypto_group(&room.id, &input).await.unwrap();
    group.merge_pending_commit(&owner.provider).unwrap();
    let message = plaintext();
    let submitted = encrypted(
        &owner,
        &mut group,
        &transition.plan.scope,
        &receipt,
        &message,
    );
    let (first, retry) = tokio::join!(
        native.submit_crypto_message(&room.id, &submitted),
        native.submit_crypto_message(&room.id, &submitted)
    );
    let first = first.unwrap();
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(retry.unwrap()).unwrap()
    );
    assert_eq!(first.position, "9007199254740994");
    assert_eq!(
        native
            .crypto_message_operation(&room.id, &message.operation_id)
            .await
            .unwrap()
            .message_id,
        first.message_id
    );
    let restarted = App::from_pool(app.pool.clone()).await.unwrap();
    let recovered: wire::ApplicationReceipt = body(
        messages::operation(&restarted, &owner.actor, &room.id, &message.operation_id)
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(recovered.position, first.position);
    let counts: (i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM e2ee_application_messages),(SELECT count(*) FROM e2ee_delivery),(SELECT count(*) FROM messages WHERE system IS NULL)").fetch_one(&app.pool).await.unwrap();
    assert_eq!(counts, (1, 2, 0));
    let ordinary_changes = native.changes(&ordinary_before.cursor).await.unwrap();
    assert_eq!(
        ordinary_changes.changes.len(),
        2,
        "Exact retries publish no duplicate room activity"
    );
    for change in &ordinary_changes.changes {
        let rv_protocol::Change::RoomUpsert(changed) = change else {
            panic!("Private activity must publish only room metadata")
        };
        assert_eq!(changed.id, room.id);
        assert!(changed.encrypted);
    }
    let encoded = serde_json::to_string(&ordinary_changes).unwrap();
    assert!(!encoded.contains(&message.text));
    assert!(!encoded.contains(&submitted.ciphertext));
    let fresh = native.snapshot().await.unwrap();
    let current = fresh.rooms.iter().find(|r| r.id == room.id).unwrap();
    assert!(current.encrypted);
    assert_eq!(current.revision, first.position);
    assert!(
        native
            .rooms()
            .await
            .unwrap()
            .iter()
            .find(|r| r.id == room.id)
            .unwrap()
            .encrypted
    );
    assert!(native.room_details(&room.id).await.unwrap().room.encrypted);
    let row: (Vec<u8>, Vec<u8>) =
        sqlx::query_as("SELECT proof,ciphertext FROM e2ee_application_messages")
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(row.0, B64.decode(submitted.proof.as_bytes()).unwrap());
    assert_eq!(row.1, B64.decode(submitted.ciphertext.as_bytes()).unwrap());
    assert!(
        !row.0
            .windows(message.text.len())
            .any(|b| b == message.text.as_bytes())
    );
    assert!(
        !row.1
            .windows(message.text.len())
            .any(|b| b == message.text.as_bytes())
    );
    native.update_token(guest.token.clone());
    let page = native.crypto_delivery(&room.id, "0", None).await.unwrap();
    assert_eq!(page.events.len(), 2);
    assert_eq!(page.events[0].position, "9007199254740993");
    assert!(page.next.is_none());
    let wire::DeliveryContent::Group(admission) = &page.events[0].content else {
        panic!("group must precede message")
    };
    let mut joined = join(&guest, admission.welcome.as_ref().unwrap());
    let wire::DeliveryContent::Message(delivered) = &page.events[1].content else {
        panic!("expected opaque message")
    };
    assert_eq!(delivered.proof, submitted.proof);
    assert_eq!(delivered.ciphertext, submitted.ciphertext);
    assert_eq!(delivered.receipt.position, page.events[1].position);
    let proof =
        packet::Proof::from_bytes(&B64.decode(delivered.proof.as_bytes()).unwrap()).unwrap();
    let header: packet::Header =
        serde_json::from_slice(&B64.decode(delivered.receipt.header.as_bytes()).unwrap()).unwrap();
    assert!(header == proof.header);
    assert_eq!(
        delivered.receipt.fingerprint,
        hex(&proof.fingerprint().unwrap())
    );
    let protocol =
        MlsMessageIn::tls_deserialize_exact(B64.decode(delivered.ciphertext.as_bytes()).unwrap())
            .unwrap()
            .try_into_protocol_message()
            .unwrap();
    let opened = joined.process_message(&guest.provider, protocol).unwrap();
    assert_eq!(opened.aad(), header.aad().unwrap());
    let ProcessedMessageContent::ApplicationMessage(opened) = opened.into_content() else {
        panic!("expected application")
    };
    let clear: serde_json::Value = serde_json::from_slice(&opened.into_bytes()).unwrap();
    assert_eq!(clear["message"]["text"], message.text);
    assert!(matches!(
        native
            .crypto_message_operation(&room.id, &message.operation_id)
            .await,
        Err(rv_client::Error::Server { status: 404, .. })
    ));
    assert!(matches!(
        native.crypto_delivery(&room.id, "01", None).await,
        Err(rv_client::Error::InvalidUrl)
    ));
    let http = reqwest::Client::new();
    for path in [
        "delivery?after=0&unknown=1".to_owned(),
        format!("message-operations/{}", message.operation_id),
    ] {
        let response = http
            .get(format!(
                "http://{address}/api/v1/e2ee/rooms/{}/{path}",
                room.id
            ))
            .bearer_auth(&guest.token)
            .send()
            .await
            .unwrap();
        assert!(matches!(response.status().as_u16(), 400 | 404));
        assert_eq!(response.headers()["cache-control"], "no-store");
    }
    let anonymous = http
        .get(format!(
            "http://{address}/api/v1/e2ee/rooms/{}/delivery",
            room.id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status().as_u16(), 401);
    assert_eq!(anonymous.headers()["cache-control"], "no-store");
    let oversized = http
        .post(format!(
            "http://{address}/api/v1/e2ee/rooms/{}/messages",
            room.id
        ))
        .bearer_auth(&owner.token)
        .header("content-type", "application/json")
        .body("x".repeat(256 * 1024 + 1))
        .send()
        .await
        .unwrap();
    assert_eq!(oversized.status().as_u16(), 413);
    assert_eq!(oversized.headers()["cache-control"], "no-store");
    server.abort();
}

#[sqlx::test]
async fn fixed_watermark_pages_interleave_real_rotations_and_messages_without_duplicates(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "application-pages").await;
    let room = room(&app, &owner, None).await;
    let (mut group, mut transition, mut receipt) = genesis(&app, &owner, &room).await;
    let mut accepted = Vec::new();
    for index in 0..18 {
        if index == 7 {
            (transition, receipt) = rotate(&app, &owner, &mut group, &transition, receipt).await;
        }
        let input = encrypted(
            &owner,
            &mut group,
            &transition.plan.scope,
            &receipt,
            &plaintext(),
        );
        accepted.push(
            messages::submit(&app, &owner.actor, &room.id, input)
                .await
                .unwrap()
                .position,
        );
    }
    let first = page(&app, &owner, &room).await;
    assert_eq!(first.events.len(), 16);
    assert_eq!(first.through, *accepted.last().unwrap());
    let late = encrypted(
        &owner,
        &mut group,
        &transition.plan.scope,
        &receipt,
        &plaintext(),
    );
    let late = messages::submit(&app, &owner.actor, &room.id, late)
        .await
        .unwrap();
    let next = first.next.as_ref().unwrap();
    let second: wire::DeliveryPage = body(
        messages::delivery(
            &app,
            &owner.actor,
            &room.id,
            Some(next),
            Some(&first.through),
        )
        .await
        .unwrap(),
    )
    .await;
    assert_eq!(second.events.len(), 4);
    assert!(second.next.is_none());
    assert_eq!(second.through, first.through);
    let events: Vec<_> = first.events.into_iter().chain(second.events).collect();
    assert!(
        events
            .windows(2)
            .all(|pair| pair[0].position.parse::<i64>().unwrap()
                < pair[1].position.parse::<i64>().unwrap())
    );
    assert!(
        matches!(&events[0].content,wire::DeliveryContent::Group(event) if event.receipt.epoch=="0")
    );
    assert!(
        matches!(&events[8].content,wire::DeliveryContent::Group(event) if event.receipt.epoch=="1")
    );
    let received: Vec<_> = events
        .iter()
        .filter_map(|event| match &event.content {
            wire::DeliveryContent::Message(message) => Some(message.receipt.position.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(received, accepted);
    let latest: wire::DeliveryPage = body(
        messages::delivery(&app, &owner.actor, &room.id, Some(&first.through), None)
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(latest.events.len(), 1);
    assert_eq!(latest.events[0].position, late.position);
    for (after, through) in [
        ("01", None),
        ("-1", None),
        ("9223372036854775808", None),
        (&late.position, Some("0")),
        ("0", Some("9223372036854775807")),
    ] {
        rejected(
            messages::delivery(&app, &owner.actor, &room.id, Some(after), through).await,
            "invalid_request",
        );
    }
}

#[sqlx::test]
async fn readmission_changes_delivery_tenure_and_preserves_only_the_removed_senders_own_ack(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "application-tenure-owner").await;
    let guest = ready(&app, "application-tenure-guest").await;
    let room = room(&app, &owner, Some(&guest)).await;
    let (mut group, transition, input) = add(&app, &owner, &guest, &room).await;
    let receipt = delivery::submit(&app, &owner.actor, &room.id, input)
        .await
        .unwrap();
    group.merge_pending_commit(&owner.provider).unwrap();
    let admission = page(&app, &guest, &room).await;
    let wire::DeliveryContent::Group(event) = &admission.events[0].content else {
        panic!("expected admission")
    };
    let mut joined = join(&guest, event.welcome.as_ref().unwrap());
    let root = encrypted(
        &owner,
        &mut group,
        &transition.plan.scope,
        &receipt,
        &plaintext(),
    );
    let root = messages::submit(&app, &owner.actor, &room.id, root)
        .await
        .unwrap();
    let mut reply = plaintext();
    reply.reply_to = Some(root.message_id.clone());
    let input = encrypted(
        &guest,
        &mut joined,
        &transition.plan.scope,
        &receipt,
        &reply,
    );
    let reply_ack = messages::submit(&app, &guest.actor, &room.id, input.clone())
        .await
        .unwrap();
    assert_eq!(page(&app, &guest, &room).await.events.len(), 3);
    store::membership(&app, &owner.actor, &room.id, &guest.actor.id, true)
        .await
        .unwrap();
    rejected(
        messages::delivery(&app, &guest.actor, &room.id, None, None).await,
        "not_found",
    );
    let own: wire::ApplicationReceipt = body(
        messages::operation(&app, &guest.actor, &room.id, &reply.operation_id)
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(own.message_id, reply_ack.message_id);
    assert_eq!(
        messages::submit(&app, &guest.actor, &room.id, input)
            .await
            .unwrap()
            .message_id,
        reply_ack.message_id
    );
    rejected(
        messages::operation(&app, &guest.actor, &room.id, &root.operation_id).await,
        "not_found",
    );
    let (commit, _, _) = group
        .remove_members(
            &owner.provider,
            &owner.client.leaf,
            &[LeafNodeIndex::new(1)],
        )
        .unwrap();
    let mut removed = Prepared::from_group(&group, &owner, transition.plan.scope.clone());
    removed.commit = Some(commit.to_bytes().unwrap());
    removed.previous = Some(receipt);
    let (_, removed_input) = signed(&app, &owner, removed).await;
    let removed_ack = delivery::submit(&app, &owner.actor, &room.id, removed_input)
        .await
        .unwrap();
    group.merge_pending_commit(&owner.provider).unwrap();
    let removal = MlsMessageIn::tls_deserialize_exact(commit.to_bytes().unwrap())
        .unwrap()
        .try_into_protocol_message()
        .unwrap();
    let ProcessedMessageContent::StagedCommitMessage(removal) = joined
        .process_message(&guest.provider, removal)
        .unwrap()
        .into_content()
    else {
        panic!("expected removal commit")
    };
    joined
        .merge_staged_commit(&guest.provider, *removal)
        .unwrap();
    assert!(!joined.is_active());
    joined.delete(guest.provider.storage()).unwrap();
    store::membership(&app, &owner.actor, &room.id, &guest.actor.id, false)
        .await
        .unwrap();
    rejected(
        messages::delivery(&app, &guest.actor, &room.id, None, None).await,
        "permission_denied",
    );
    let (package, reference) = guest.package(&app).await;
    let (commit, welcome, _) = group
        .add_members(&owner.provider, &owner.client.leaf, &[package])
        .unwrap();
    let mut readded = Prepared::from_group(&group, &owner, transition.plan.scope.clone());
    readded
        .participants
        .push(guest.participant(1, Some(reference)));
    readded.commit = Some(commit.to_bytes().unwrap());
    readded.previous = Some(removed_ack);
    readded.welcomes.push(wire::GroupWelcome {
        device_id: guest.client.certificate.device.device.clone(),
        incarnation: hex(&guest.client.certificate.device.incarnation),
        key_package_ref: B64.encode(&reference),
        payload: B64.encode(&welcome.to_bytes().unwrap()),
    });
    let (readded, input) = signed(&app, &owner, readded).await;
    let receipt = delivery::submit(&app, &owner.actor, &room.id, input)
        .await
        .unwrap();
    group.merge_pending_commit(&owner.provider).unwrap();
    let current = page(&app, &guest, &room).await;
    assert_eq!(current.events.len(), 1);
    assert!(
        matches!(&current.events[0].content,wire::DeliveryContent::Group(event) if event.receipt.revision=="3"&&event.welcome.is_some())
    );
    let mut wrong_thread = plaintext();
    wrong_thread.reply_to = Some(root.message_id);
    let wrong_thread = encrypted(
        &owner,
        &mut group,
        &readded.plan.scope,
        &receipt,
        &wrong_thread,
    );
    // The retained owner still has this root, while the newly admitted guest does not.
    messages::submit(&app, &owner.actor, &room.id, wrong_thread)
        .await
        .unwrap();
    let wire::DeliveryContent::Group(event) = &current.events[0].content else {
        panic!("expected readmission")
    };
    let mut rejoined = join(&guest, event.welcome.as_ref().unwrap());
    let mut guest_thread = plaintext();
    guest_thread.reply_to = reply.reply_to;
    let guest_thread = encrypted(
        &guest,
        &mut rejoined,
        &readded.plan.scope,
        &receipt,
        &guest_thread,
    );
    rejected(
        messages::submit(&app, &guest.actor, &room.id, guest_thread).await,
        "invalid_thread_root",
    );
    assert_eq!(page(&app, &guest, &room).await.events.len(), 2);
    assert_eq!(page(&app, &owner, &room).await.events.len(), 6);
}

#[sqlx::test]
async fn quota_and_operation_namespaces_are_durable_and_rejected_sends_leave_no_delivery(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "application-budget").await;
    let room = room(&app, &owner, None).await;
    let (mut group, transition, receipt) = genesis(&app, &owner, &room).await;
    let input = encrypted(
        &owner,
        &mut group,
        &transition.plan.scope,
        &receipt,
        &plaintext(),
    );
    let ack = messages::submit(&app, &owner.actor, &room.id, input.clone())
        .await
        .unwrap();
    let mut changed = input.clone();
    changed.ciphertext.push('A');
    rejected(
        messages::submit(&app, &owner.actor, &room.id, changed).await,
        "operation_conflict",
    );
    let plain_room = store::create_room(
        &app,
        &owner.actor,
        CreateRoom {
            name: "application-plain-namespace".into(),
            private: true,
            operation_id: None,
        },
    )
    .await
    .unwrap();
    let mut text = plaintext();
    text.operation_id = ack.operation_id.clone();
    rejected(
        store::send(&app, &owner.actor, &plain_room.id, text).await,
        "operation_conflict",
    );
    let used_text = plaintext();
    store::send(&app, &owner.actor, &plain_room.id, used_text.clone())
        .await
        .unwrap();
    let used_input = encrypted(
        &owner,
        &mut group,
        &transition.plan.scope,
        &receipt,
        &used_text,
    );
    rejected(
        messages::submit(&app, &owner.actor, &room.id, used_input).await,
        "operation_conflict",
    );
    sqlx::query("UPDATE e2ee_message_budgets SET used=600,window_start=clock_timestamp()")
        .execute(&app.pool)
        .await
        .unwrap();
    let restarted = App::from_pool(app.pool.clone()).await.unwrap();
    assert_eq!(
        messages::submit(&restarted, &owner.actor, &room.id, input)
            .await
            .unwrap()
            .position,
        ack.position
    );
    let full = encrypted(
        &owner,
        &mut group,
        &transition.plan.scope,
        &receipt,
        &plaintext(),
    );
    rejected(
        messages::submit(&restarted, &owner.actor, &room.id, full.clone()).await,
        "crypto_message_limit",
    );
    assert_eq!(page(&app, &owner, &room).await.events.len(), 2);
    sqlx::query(
        "UPDATE e2ee_message_budgets SET window_start=clock_timestamp()-interval '61 seconds'",
    )
    .execute(&app.pool)
    .await
    .unwrap();
    messages::submit(&restarted, &owner.actor, &room.id, full)
        .await
        .unwrap();
    assert_eq!(page(&app, &owner, &room).await.events.len(), 3);
}

#[sqlx::test]
async fn authentic_but_stale_headers_bad_signatures_and_wrong_scopes_are_refused(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "application-validation").await;
    let room = room(&app, &owner, None).await;
    let (mut group, transition, receipt) = genesis(&app, &owner, &room).await;
    let input = encrypted(
        &owner,
        &mut group,
        &transition.plan.scope,
        &receipt,
        &plaintext(),
    );
    let mut wrong = input.clone();
    wrong.scope.data_epoch = auth::random_token();
    rejected(
        messages::submit(&app, &owner.actor, &room.id, wrong).await,
        "data_epoch_changed",
    );
    let mut wrong = input.clone();
    let mut proof =
        packet::Proof::from_bytes(&B64.decode(wrong.proof.as_bytes()).unwrap()).unwrap();
    proof.signature[0] ^= 1;
    wrong.proof = B64.encode(&proof.to_bytes().unwrap());
    rejected(
        messages::submit(&app, &owner.actor, &room.id, wrong).await,
        "crypto_proof_invalid",
    );
    let mut wrong = input.clone();
    let mut tampered = B64.decode(wrong.ciphertext.as_bytes()).unwrap();
    tampered[0] ^= 1;
    wrong.ciphertext = B64.encode(&tampered);
    rejected(
        messages::submit(&app, &owner.actor, &room.id, wrong).await,
        "crypto_proof_invalid",
    );
    let mut wrong = input.clone();
    let mut proof =
        packet::Proof::from_bytes(&B64.decode(wrong.proof.as_bytes()).unwrap()).unwrap();
    proof.header.group_fingerprint = [4; 32];
    proof.signature = owner
        .client
        .leaf
        .sign(&proof.signing_bytes().unwrap())
        .unwrap();
    wrong.proof = B64.encode(&proof.to_bytes().unwrap());
    rejected(
        messages::submit(&app, &owner.actor, &room.id, wrong).await,
        "crypto_group_changed",
    );
    let (_, _) = rotate(&app, &owner, &mut group, &transition, receipt).await;
    rejected(
        messages::submit(&app, &owner.actor, &room.id, input).await,
        "crypto_group_changed",
    );
    assert_eq!(page(&app, &owner, &room).await.events.len(), 2);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_application_messages")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test]
async fn unconsumed_delivery_holds_access_until_flush_and_expires_at_the_session_deadline(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "application-lease-owner").await;
    let guest = ready(&app, "application-lease-guest").await;
    let room = room(&app, &owner, Some(&guest)).await;
    let (mut group, transition, input) = add(&app, &owner, &guest, &room).await;
    let receipt = delivery::submit(&app, &owner.actor, &room.id, input)
        .await
        .unwrap();
    group.merge_pending_commit(&owner.provider).unwrap();
    let input = encrypted(
        &owner,
        &mut group,
        &transition.plan.scope,
        &receipt,
        &plaintext(),
    );
    messages::submit(&app, &owner.actor, &room.id, input)
        .await
        .unwrap();
    let response = messages::delivery(&app, &guest.actor, &room.id, None, None)
        .await
        .unwrap();
    let removed = tokio::spawn({
        let app = app.clone();
        let actor = owner.actor.clone();
        let room = room.id.clone();
        let user = guest.actor.id.clone();
        async move { store::membership(&app, &actor, &room, &user, true).await }
    });
    super::roster_observation::wait_for_lock(&app.pool).await;
    assert!(!removed.is_finished());
    let delivered: wire::DeliveryPage = body(response).await;
    assert_eq!(delivered.events.len(), 2);
    tokio::time::timeout(Duration::from_secs(3), removed)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    rejected(
        messages::delivery(&app, &guest.actor, &room.id, None, None).await,
        "not_found",
    );
    sqlx::query("UPDATE sessions SET expires_at=clock_timestamp()+interval '600 milliseconds' WHERE token_hash=$1").bind(&owner.actor.session_hash).execute(&app.pool).await.unwrap();
    let response = messages::delivery(&app, &owner.actor, &room.id, None, None)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(750)).await;
    assert!(
        to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .is_err()
    );
}

#[sqlx::test]
async fn legacy_backfill_reconstructs_the_exact_admission_witness_and_ordered_frames(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "application-backfill").await;
    let room = room(&app, &owner, None).await;
    let (mut group, transition, receipt) = genesis(&app, &owner, &room).await;
    rotate(&app, &owner, &mut group, &transition, receipt).await;
    let original = page(&app, &owner, &room).await;
    assert_eq!(original.events.len(), 2);
    let witnesses: Vec<(i64, serde_json::Value)> =
        sqlx::query_as("SELECT revision,witness FROM e2ee_group_recipients ORDER BY revision")
            .fetch_all(&app.pool)
            .await
            .unwrap();
    sqlx::query("DELETE FROM e2ee_delivery")
        .execute(&app.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM e2ee_group_recipients")
        .execute(&app.pool)
        .await
        .unwrap();
    let migration = include_str!("../../../migrations/0040_e2ee_application_delivery.sql");
    let recipients = migration
        .split_once("INSERT INTO e2ee_group_recipients")
        .unwrap()
        .1
        .split_once("CREATE TABLE e2ee_application_messages")
        .unwrap()
        .0;
    sqlx::raw_sql(&format!("INSERT INTO e2ee_group_recipients{recipients}"))
        .execute(&app.pool)
        .await
        .unwrap();
    let sequencer = migration
        .split_once("DO $$")
        .unwrap()
        .1
        .split_once("CREATE TABLE e2ee_message_budgets")
        .unwrap()
        .0;
    sqlx::raw_sql(&format!("DO $${sequencer}"))
        .execute(&app.pool)
        .await
        .unwrap();
    let restored: Vec<(i64, serde_json::Value)> =
        sqlx::query_as("SELECT revision,witness FROM e2ee_group_recipients ORDER BY revision")
            .fetch_all(&app.pool)
            .await
            .unwrap();
    assert_eq!(restored, witnesses);
    let restored = page(&app, &owner, &room).await;
    assert_eq!(restored.events.len(), 2);
    assert!(
        restored
            .events
            .windows(2)
            .all(|p| p[0].position.parse::<i64>().unwrap() < p[1].position.parse::<i64>().unwrap())
    );
    for (old, new) in original.events.iter().zip(restored.events.iter()) {
        assert_eq!(
            serde_json::to_value(&old.content).unwrap(),
            serde_json::to_value(&new.content).unwrap()
        );
    }
}

#[sqlx::test]
async fn concurrent_crypto_and_plain_publishers_share_the_native_sequencer_without_lock_upgrades(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let first = ready(&app, "application-counter-first").await;
    let second = ready(&app, "application-counter-second").await;
    let plain = ready(&app, "application-counter-plain").await;
    let first_room = room(&app, &first, None).await;
    let second_room = room(&app, &second, None).await;
    let plain_room = room(&app, &plain, None).await;
    let (mut first_group, first_plan, first_receipt) = genesis(&app, &first, &first_room).await;
    let (mut second_group, second_plan, second_receipt) =
        genesis(&app, &second, &second_room).await;
    let first_input = encrypted(
        &first,
        &mut first_group,
        &first_plan.plan.scope,
        &first_receipt,
        &plaintext(),
    );
    let second_input = encrypted(
        &second,
        &mut second_group,
        &second_plan.plan.scope,
        &second_receipt,
        &plaintext(),
    );
    let mut counter = app.pool.begin().await.unwrap();
    sqlx::query("SELECT position FROM instance WHERE singleton FOR NO KEY UPDATE")
        .fetch_one(&mut *counter)
        .await
        .unwrap();
    let first_task = tokio::spawn({
        let app = app.clone();
        let actor = first.actor.clone();
        let room = first_room.id.clone();
        async move { messages::submit(&app, &actor, &room, first_input).await }
    });
    let second_task = tokio::spawn({
        let app = app.clone();
        let actor = second.actor.clone();
        let room = second_room.id.clone();
        async move { messages::submit(&app, &actor, &room, second_input).await }
    });
    let plain_task = tokio::spawn({
        let app = app.clone();
        let actor = plain.actor.clone();
        let room = plain_room.id.clone();
        async move { store::send(&app, &actor, &room, plaintext()).await }
    });
    // Both crypto writers must reach the global UPDATE while holding compatible
    // scope locks; an instance SHARE lease would block them before this point.
    tokio::time::timeout(Duration::from_secs(5),async {
        loop {
            let blocked:i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE instance SET position%'").fetch_one(&app.pool).await.unwrap();
            if blocked>=2 {break;}
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    counter.commit().await.unwrap();
    let (first, second, plain) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(first_task, second_task, plain_task)
    })
    .await
    .unwrap();
    let mut positions = [
        first.unwrap().unwrap().position,
        second.unwrap().unwrap().position,
        plain.unwrap().unwrap().position,
    ]
    .map(|v| v.parse::<i64>().unwrap());
    positions.sort();
    assert!(positions.windows(2).all(|p| p[1] > p[0]));
    let final_position: i64 = sqlx::query_scalar("SELECT position FROM instance WHERE singleton")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert!(final_position >= positions[2]);
}

#[sqlx::test]
async fn peer_activation_is_fenced_before_room_lock_and_current_send_rights_remain_authoritative(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "application-activation-owner").await;
    let guest = ready(&app, "application-activation-guest").await;
    let room = room(&app, &owner, Some(&guest)).await;
    let (mut group, transition, input) = add(&app, &owner, &guest, &room).await;
    let receipt = delivery::submit(&app, &owner.actor, &room.id, input)
        .await
        .unwrap();
    group.merge_pending_commit(&owner.provider).unwrap();
    let admission = page(&app, &guest, &room).await;
    let wire::DeliveryContent::Group(event) = &admission.events[0].content else {
        panic!("expected admission")
    };
    let mut joined = join(&guest, event.welcome.as_ref().unwrap());
    let forbidden = encrypted(
        &guest,
        &mut joined,
        &transition.plan.scope,
        &receipt,
        &plaintext(),
    );
    sqlx::query("UPDATE rooms SET read_only=true WHERE id=$1")
        .bind(&room.id)
        .execute(&app.pool)
        .await
        .unwrap();
    rejected(
        messages::submit(&app, &guest.actor, &room.id, forbidden).await,
        "permission_denied",
    );
    // Settings update the signed authority version too. The owner refreshes
    // that policy with an actual MLS transition before sending again.
    let (transition, receipt) = rotate(&app, &owner, &mut group, &transition, receipt).await;
    let allowed = encrypted(
        &owner,
        &mut group,
        &transition.plan.scope,
        &receipt,
        &plaintext(),
    );
    messages::submit(&app, &owner.actor, &room.id, allowed)
        .await
        .unwrap();
    let pending = encrypted(
        &owner,
        &mut group,
        &transition.plan.scope,
        &receipt,
        &plaintext(),
    );
    let mut operator = app.pool.begin().await.unwrap();
    sqlx::query(
        "UPDATE users SET disabled=true,activation_version=gen_random_uuid()::text WHERE id=$1",
    )
    .bind(&guest.actor.id)
    .execute(&mut *operator)
    .await
    .unwrap();
    let sending = tokio::spawn({
        let app = app.clone();
        let actor = owner.actor.clone();
        let room = room.id.clone();
        async move { messages::submit(&app, &actor, &room, pending).await }
    });
    tokio::time::timeout(Duration::from_secs(3),async {
        loop {
            let blocked:bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id,activation_version FROM users%')").fetch_one(&app.pool).await.unwrap();
            if blocked {break;}
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.unwrap();
    // Disabling operators take a user key lock before rooms. The crypto writer
    // must not hold the room while waiting for that key, forming a cycle.
    tokio::time::timeout(
        Duration::from_secs(3),
        sqlx::query("SELECT id FROM rooms WHERE id=$1 FOR UPDATE")
            .bind(&room.id)
            .fetch_one(&mut *operator),
    )
    .await
    .unwrap()
    .unwrap();
    operator.commit().await.unwrap();
    rejected(
        tokio::time::timeout(Duration::from_secs(3), sending)
            .await
            .unwrap()
            .unwrap(),
        "crypto_rekey_required",
    );
    assert_eq!(page(&app, &owner, &room).await.events.len(), 3);
}

#[sqlx::test]
async fn only_the_authors_own_messages_of_the_room_are_amended_in_their_thread(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "amendment-owner").await;
    let room = room(&app, &owner, None).await;
    let (mut group, transition, receipt) = genesis(&app, &owner, &room).await;
    let scope = &transition.plan.scope;
    let original = encrypted(&owner, &mut group, scope, &receipt, &plaintext());
    let target = messages::submit(&app, &owner.actor, &room.id, original)
        .await
        .unwrap()
        .message_id;
    let amendment = |text: &str, reply_to: Option<String>| SendMessage {
        operation_id: auth::random_token(),
        text: text.into(),
        quotes: vec![],
        reply_to,
        cards: vec![],
    };
    // An unknown target, or a thread other than the target's, is refused.
    let unknown = encrypted_as(
        &owner,
        &mut group,
        scope,
        &receipt,
        &amendment("edited", None),
        packet::Kind::Edit,
        Some("missing-message".into()),
    );
    rejected(
        messages::submit(&app, &owner.actor, &room.id, unknown).await,
        "invalid_amendment_target",
    );
    let threaded = encrypted_as(
        &owner,
        &mut group,
        scope,
        &receipt,
        &amendment("edited", Some(target.clone())),
        packet::Kind::Edit,
        Some(target.clone()),
    );
    rejected(
        messages::submit(&app, &owner.actor, &room.id, threaded).await,
        "invalid_amendment_target",
    );
    // The author's edit is accepted; an amendment of that amendment is not.
    let edit = encrypted_as(
        &owner,
        &mut group,
        scope,
        &receipt,
        &amendment("edited", None),
        packet::Kind::Edit,
        Some(target.clone()),
    );
    let edited = messages::submit(&app, &owner.actor, &room.id, edit)
        .await
        .unwrap()
        .message_id;
    let chained = encrypted_as(
        &owner,
        &mut group,
        scope,
        &receipt,
        &amendment("", None),
        packet::Kind::Delete,
        Some(edited),
    );
    rejected(
        messages::submit(&app, &owner.actor, &room.id, chained).await,
        "invalid_amendment_target",
    );
    let delete = encrypted_as(
        &owner,
        &mut group,
        scope,
        &receipt,
        &amendment("", None),
        packet::Kind::Delete,
        Some(target.clone()),
    );
    messages::submit(&app, &owner.actor, &room.id, delete)
        .await
        .unwrap();
    let stored: Option<String> = sqlx::query_scalar(
        "SELECT target FROM e2ee_application_messages WHERE target IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    )
    .fetch_one(&app.pool)
    .await
    .unwrap();
    assert_eq!(stored, Some(target));
}
