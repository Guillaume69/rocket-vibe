use super::*;

fn cancelled(value: wire::ApplicationSettlement) -> wire::ApplicationCancellation {
    match value {
        wire::ApplicationSettlement::Cancelled(receipt) => receipt,
        _ => panic!("expected cancellation"),
    }
}
fn resign_input(owner: &Ready, input: &mut wire::ApplicationSubmission, at: u64) {
    let mut proof =
        packet::Proof::from_bytes(&B64.decode(input.proof.as_bytes()).unwrap()).unwrap();
    proof.certificate.device.issued_at = at;
    proof.certificate.device.expires_at = at + 600;
    proof.certificate.signature = owner
        .client
        .signing
        .sign(&signing_bytes(CERT_DOMAIN, &proof.certificate.device).unwrap())
        .to_bytes()
        .to_vec();
    proof.header.certificate = proof.certificate.fingerprint().unwrap();
    proof.signature = owner
        .client
        .leaf
        .sign(&proof.signing_bytes().unwrap())
        .unwrap();
    input.proof = B64.encode(&proof.to_bytes().unwrap());
}

#[sqlx::test]
async fn own_http_abandonment_reopens_after_withdrawal_and_expiry_and_fences_late_post(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "cancellation-http-owner").await;
    let room = room(&app, &owner, None).await;
    let (mut group, transition, head) = genesis(&app, &owner, &room).await;
    let mut input = encrypted(
        &owner,
        &mut group,
        &transition.plan.scope,
        &head,
        &plaintext(),
    );
    resign_input(&owner, &mut input, Utc::now().timestamp() as u64 - 3600);
    rejected(
        messages::submit(&app, &owner.actor, &room.id, input.clone()).await,
        "crypto_proof_invalid",
    );
    sqlx::query("DELETE FROM members WHERE room_id=$1 AND user_id=$2")
        .bind(&room.id)
        .bind(&owner.actor.id)
        .execute(&app.pool)
        .await
        .unwrap();
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = socket.local_addr().unwrap();
    let router = crate::http::router(app.clone());
    let server = tokio::spawn(async move { axum::serve(socket, router).await.unwrap() });
    let client = rv_client::NativeClient::new(&format!("http://{address}")).unwrap();
    let (_, recovery_token) = login(&app, "cancellation-http-owner").await;
    client.update_token(recovery_token);
    let receipt = cancelled(
        client
            .cancel_crypto_message(&room.id, &input)
            .await
            .unwrap(),
    );
    assert_eq!(receipt.operation_id, input.operation_id);
    rejected(
        messages::operation(&app, &owner.actor, &room.id, &input.operation_id).await,
        "crypto_message_cancelled",
    );
    let proof = packet::Proof::from_bytes(&B64.decode(input.proof.as_bytes()).unwrap()).unwrap();
    assert_eq!(receipt.fingerprint, hex(&proof.fingerprint().unwrap()));
    let restarted = App::from_pool(app.pool.clone()).await.unwrap();
    let retry = cancelled(
        messages::cancel(
            &restarted,
            &owner.actor,
            &room.id,
            &input.operation_id,
            input.clone(),
        )
        .await
        .unwrap(),
    );
    assert_eq!(
        serde_json::to_value(&retry).unwrap(),
        serde_json::to_value(&receipt).unwrap()
    );
    rejected(
        messages::submit(&restarted, &owner.actor, &room.id, input.clone()).await,
        "crypto_message_cancelled",
    );
    let mut divergent = input.clone();
    divergent.ciphertext.push('A');
    rejected(
        messages::cancel(
            &restarted,
            &owner.actor,
            &room.id,
            &input.operation_id,
            divergent,
        )
        .await,
        "operation_conflict",
    );
    let other = super::room(&app, &owner, None).await;
    rejected(
        messages::submit(&restarted, &owner.actor, &other.id, input.clone()).await,
        "operation_conflict",
    );
    let counts: (i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM e2ee_application_messages),(SELECT count(*) FROM e2ee_delivery),(SELECT count(*) FROM e2ee_message_cancellations)").fetch_one(&app.pool).await.unwrap();
    assert_eq!(counts, (0, 1, 1));
    let request = reqwest::Client::new()
        .post(format!(
            "http://{address}/api/v1/e2ee/rooms/{}/message-operations/{}/cancel",
            room.id, input.operation_id
        ))
        .bearer_auth(&owner.token)
        .json(&input)
        .send()
        .await
        .unwrap();
    assert_eq!(request.headers().get("cache-control").unwrap(), "no-store");
    server.abort();
}

#[sqlx::test]
async fn cancellation_and_real_mls_submission_have_one_terminal_result_under_races(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "cancellation-racing-owner").await;
    let room = room(&app, &owner, None).await;
    let (mut group, transition, head) = genesis(&app, &owner, &room).await;
    let mut accepted = 0;
    let mut abandoned = 0;
    for _ in 0..8 {
        let input = encrypted(
            &owner,
            &mut group,
            &transition.plan.scope,
            &head,
            &plaintext(),
        );
        let (send, cancel) = tokio::join!(
            messages::submit(&app, &owner.actor, &room.id, input.clone()),
            messages::cancel(
                &app,
                &owner.actor,
                &room.id,
                &input.operation_id,
                input.clone()
            )
        );
        match cancel.unwrap() {
            wire::ApplicationSettlement::Accepted(receipt) => {
                accepted += 1;
                assert_eq!(send.unwrap().message_id, receipt.message_id);
                assert_eq!(
                    messages::submit(&app, &owner.actor, &room.id, input)
                        .await
                        .unwrap()
                        .position,
                    receipt.position
                );
            }
            wire::ApplicationSettlement::Cancelled(_) => {
                abandoned += 1;
                rejected(send, "crypto_message_cancelled");
                rejected(
                    messages::submit(&app, &owner.actor, &room.id, input).await,
                    "crypto_message_cancelled",
                );
            }
        }
    }
    let counts: (i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM e2ee_application_messages),(SELECT count(*) FROM e2ee_delivery),(SELECT count(*) FROM e2ee_message_cancellations)").fetch_one(&app.pool).await.unwrap();
    assert_eq!(counts, (accepted, accepted + 1, abandoned));
    // An already committed message is never converted into an abandonment.
    let input = encrypted(
        &owner,
        &mut group,
        &transition.plan.scope,
        &head,
        &plaintext(),
    );
    let receipt = messages::submit(&app, &owner.actor, &room.id, input.clone())
        .await
        .unwrap();
    sqlx::query("DELETE FROM members WHERE room_id=$1")
        .bind(&room.id)
        .execute(&app.pool)
        .await
        .unwrap();
    let wire::ApplicationSettlement::Accepted(settled) = messages::cancel(
        &app,
        &owner.actor,
        &room.id,
        &input.operation_id,
        input.clone(),
    )
    .await
    .unwrap() else {
        panic!("accepted send was abandoned")
    };
    assert_eq!(
        serde_json::to_value(settled).unwrap(),
        serde_json::to_value(receipt).unwrap()
    );
}

#[sqlx::test]
async fn ordinary_operations_and_cancellation_share_the_author_namespace_and_budget(pool: PgPool) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "cancellation-namespace-owner").await;
    let encrypted_room = room(&app, &owner, None).await;
    let (mut group, transition, head) = genesis(&app, &owner, &encrypted_room).await;
    let plain = room(&app, &owner, None).await;
    let doc = plaintext();
    let input = encrypted(&owner, &mut group, &transition.plan.scope, &head, &doc);
    let receipt = cancelled(
        messages::cancel(
            &app,
            &owner.actor,
            &encrypted_room.id,
            &input.operation_id,
            input.clone(),
        )
        .await
        .unwrap(),
    );
    rejected(
        store::send(&app, &owner.actor, &plain.id, doc.clone()).await,
        "operation_conflict",
    );
    rejected(
        store::create_room(
            &app,
            &owner.actor,
            CreateRoom {
                name: "namespace-reuse".into(),
                private: true,
                operation_id: Some(doc.operation_id),
            },
        )
        .await,
        "operation_conflict",
    );
    let doc = plaintext();
    store::send(&app, &owner.actor, &plain.id, doc.clone())
        .await
        .unwrap();
    let used = encrypted(&owner, &mut group, &transition.plan.scope, &head, &doc);
    rejected(
        messages::cancel(
            &app,
            &owner.actor,
            &encrypted_room.id,
            &used.operation_id,
            used.clone(),
        )
        .await,
        "operation_conflict",
    );
    // Durable limit applies only to new tombstones; exact reconciliation remains.
    sqlx::query("INSERT INTO e2ee_message_cancellations(user_id,operation_id,fingerprint,receipt) SELECT $1,'budget-'||n,$2,$3 FROM generate_series(1,599) n").bind(&owner.actor.id).bind("synthetic-budget").bind(sqlx::types::Json(receipt)).execute(&app.pool).await.unwrap();
    let restarted = App::from_pool(app.pool.clone()).await.unwrap();
    cancelled(
        messages::cancel(
            &restarted,
            &owner.actor,
            &encrypted_room.id,
            &input.operation_id,
            input.clone(),
        )
        .await
        .unwrap(),
    );
    let full = encrypted(
        &owner,
        &mut group,
        &transition.plan.scope,
        &head,
        &plaintext(),
    );
    rejected(
        messages::cancel(
            &restarted,
            &owner.actor,
            &encrypted_room.id,
            &full.operation_id,
            full.clone(),
        )
        .await,
        "crypto_cancellation_limit",
    );
    messages::submit(&restarted, &owner.actor, &encrypted_room.id, full)
        .await
        .unwrap();
}

#[sqlx::test]
async fn cancellation_refuses_substituted_owner_scope_route_signature_and_future_certificate(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "cancellation-proof-owner").await;
    let guest = ready(&app, "cancellation-proof-guest").await;
    let room = room(&app, &owner, None).await;
    let (mut group, transition, head) = genesis(&app, &owner, &room).await;
    let input = encrypted(
        &owner,
        &mut group,
        &transition.plan.scope,
        &head,
        &plaintext(),
    );
    rejected(
        messages::cancel(
            &app,
            &guest.actor,
            &room.id,
            &input.operation_id,
            input.clone(),
        )
        .await,
        "crypto_proof_invalid",
    );
    rejected(
        messages::cancel(
            &app,
            &owner.actor,
            &room.id,
            "wrong-operation",
            input.clone(),
        )
        .await,
        "invalid_request",
    );
    let mut future = input.clone();
    resign_input(&owner, &mut future, Utc::now().timestamp() as u64 + 100);
    rejected(
        messages::cancel(&app, &owner.actor, &room.id, &input.operation_id, future).await,
        "crypto_proof_invalid",
    );
    let mut corrupted = input.clone();
    let mut proof =
        packet::Proof::from_bytes(&B64.decode(corrupted.proof.as_bytes()).unwrap()).unwrap();
    proof.signature[0] ^= 1;
    corrupted.proof = B64.encode(&proof.to_bytes().unwrap());
    rejected(
        messages::cancel(&app, &owner.actor, &room.id, &input.operation_id, corrupted).await,
        "crypto_proof_invalid",
    );
    let mut stale = input.clone();
    stale.scope.data_epoch = "old-data-epoch".into();
    rejected(
        messages::cancel(&app, &owner.actor, &room.id, &input.operation_id, stale).await,
        "data_epoch_changed",
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_message_cancellations")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    messages::submit(&app, &owner.actor, &room.id, input)
        .await
        .unwrap();
}
