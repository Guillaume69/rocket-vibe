use super::*;
use sqlx::types::Json;

#[sqlx::test]
async fn group_abandonment_daily_budget_refuses_new_intentions_but_preserves_terminal_retries(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "group-budget-owner").await;
    let guest = ready(&app, "group-budget-guest").await;
    let room = room(&app, &owner, Some(&guest)).await;
    let (_, _, original) = add(&app, &owner, &guest, &room).await;
    let saved = delivery::cancel(
        &app,
        &owner.actor,
        &room.id,
        &original.operation_id,
        original.clone(),
    )
    .await
    .unwrap();
    let wire::GroupSettlement::Cancelled(metadata) = &saved else {
        panic!("wrong decision")
    };
    sqlx::query("INSERT INTO e2ee_group_cancellations(user_id,device_id,operation_id,fingerprint,receipt) SELECT $1,$2,'quota-marker-'||n,$3,$4 FROM generate_series(1,255) n")
        .bind(&owner.actor.id).bind(&owner.client.certificate.device.device).bind(hex(&[5;32])).bind(Json(metadata)).execute(&app.pool).await.unwrap();
    let next_room = super::room(&app, &owner, Some(&guest)).await;
    let (_, _, next) = add(&app, &owner, &guest, &next_room).await;
    rejected(
        delivery::cancel(
            &app,
            &owner.actor,
            &next_room.id,
            &next.operation_id,
            next.clone(),
        )
        .await,
        "crypto_group_cancellation_limit",
    );
    let restarted = App::from_pool(app.pool.clone()).await.unwrap();
    same(
        &delivery::cancel(
            &restarted,
            &owner.actor,
            &room.id,
            &original.operation_id,
            original.clone(),
        )
        .await
        .unwrap(),
        &saved,
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM e2ee_group_cancellations WHERE user_id=$1")
            .bind(&owner.actor.id)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(count, 256);
    let spent: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_key_packages WHERE spent")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(spent, 0);
}

fn abandoned(value: wire::GroupSettlement) -> wire::GroupCancellation {
    match value {
        wire::GroupSettlement::Cancelled(value) => value,
        _ => panic!("expected abandonment"),
    }
}
fn same(a: &impl serde::Serialize, b: &impl serde::Serialize) {
    assert_eq!(
        serde_json::to_value(a).unwrap(),
        serde_json::to_value(b).unwrap()
    );
}
fn resign(owner: &Ready, input: &mut wire::GroupSubmission, at: u64) {
    let mut transition =
        Transition::from_bytes(&B64.decode(input.transition.as_bytes()).unwrap()).unwrap();
    transition.certificate.device.issued_at = at;
    transition.certificate.device.expires_at = at + 600;
    transition.certificate.signature = owner
        .client
        .signing
        .sign(&signing_bytes(CERT_DOMAIN, &transition.certificate.device).unwrap())
        .to_bytes()
        .to_vec();
    let fingerprint = transition.certificate.fingerprint().unwrap();
    transition
        .plan
        .participants
        .iter_mut()
        .find(|p| p.device == transition.certificate.device.device)
        .unwrap()
        .certificate = fingerprint;
    transition.signature = owner
        .client
        .leaf
        .sign(&transition.plan.signing_bytes().unwrap())
        .unwrap();
    input.transition = B64.encode(&transition.to_bytes().unwrap());
}

#[sqlx::test]
async fn personal_group_receipts_survive_withdrawal_and_retirement_without_restoring_delivery(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "group-personal-owner").await;
    let guest = ready(&app, "group-personal-guest").await;
    let room = room(&app, &owner, Some(&guest)).await;
    let (_, _, input) = add(&app, &owner, &guest, &room).await;
    let receipt = delivery::submit(&app, &owner.actor, &room.id, input.clone())
        .await
        .unwrap();
    sqlx::query("DELETE FROM members WHERE room_id=$1 AND user_id=$2")
        .bind(&room.id)
        .bind(&owner.actor.id)
        .execute(&app.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE e2ee_devices SET expires_at=floor(EXTRACT(EPOCH FROM clock_timestamp()))::bigint-1 WHERE device_id=$1").bind(&owner.client.certificate.device.device).execute(&app.pool).await.unwrap();
    let restarted = App::from_pool(app.pool.clone()).await.unwrap();
    let ack: wire::GroupReceipt = body(
        delivery::operation(&restarted, &owner.actor, &room.id, &input.operation_id)
            .await
            .unwrap(),
    )
    .await;
    same(&ack, &receipt);
    same(
        &delivery::submit(&restarted, &owner.actor, &room.id, input.clone())
            .await
            .unwrap(),
        &receipt,
    );
    let wire::GroupSettlement::Accepted(ack) = delivery::cancel(
        &restarted,
        &owner.actor,
        &room.id,
        &input.operation_id,
        input.clone(),
    )
    .await
    .unwrap() else {
        panic!("accepted transition lost")
    };
    same(&ack, &receipt);
    rejected(
        delivery::operation(&restarted, &guest.actor, &room.id, &input.operation_id).await,
        "not_found",
    );
    rejected(
        delivery::events(&restarted, &owner.actor, &room.id, None).await,
        "not_found",
    );
    rejected(
        delivery::state(&restarted, &owner.actor, &room.id).await,
        "not_found",
    );
    let mut divergent = input.clone();
    divergent.tree.push('A');
    rejected(
        delivery::submit(&restarted, &owner.actor, &room.id, divergent).await,
        "operation_conflict",
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_group_cancellations")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test]
async fn opaque_group_abandonment_reopens_after_expiry_and_keeps_packages_and_room_empty(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "group-cancel-owner").await;
    let guest = ready(&app, "group-cancel-guest").await;
    let room = room(&app, &owner, Some(&guest)).await;
    let (_, _, mut input) = add(&app, &owner, &guest, &room).await;
    resign(&owner, &mut input, Utc::now().timestamp() as u64 - 3600);
    sqlx::query("DELETE FROM members WHERE room_id=$1 AND user_id=$2")
        .bind(&room.id)
        .bind(&owner.actor.id)
        .execute(&app.pool)
        .await
        .unwrap();
    let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", socket.local_addr().unwrap());
    let router = crate::http::router(app.clone());
    let server = tokio::spawn(async move { axum::serve(socket, router).await.unwrap() });
    let client = rv_client::NativeClient::new(&base).unwrap();
    let (_, token) = login(&app, "group-cancel-owner").await;
    client.update_token(token);
    let receipt = abandoned(client.cancel_crypto_group(&room.id, &input).await.unwrap());
    let transition =
        Transition::from_bytes(&B64.decode(input.transition.as_bytes()).unwrap()).unwrap();
    assert_eq!(receipt.fingerprint, hex(&transition.fingerprint().unwrap()));
    assert_eq!(receipt.device_id, owner.client.certificate.device.device);
    let restarted = App::from_pool(app.pool.clone()).await.unwrap();
    let again = abandoned(
        delivery::cancel(
            &restarted,
            &owner.actor,
            &room.id,
            &input.operation_id,
            input.clone(),
        )
        .await
        .unwrap(),
    );
    same(&receipt, &again);
    rejected(
        delivery::submit(&restarted, &owner.actor, &room.id, input.clone()).await,
        "crypto_group_cancelled",
    );
    rejected(
        delivery::operation(&restarted, &owner.actor, &room.id, &input.operation_id).await,
        "crypto_group_cancelled",
    );
    let counts:(i64,i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM e2ee_groups),(SELECT count(*) FROM e2ee_delivery),(SELECT count(*) FROM e2ee_group_cancellations),(SELECT count(*) FROM e2ee_key_packages WHERE spent)").fetch_one(&app.pool).await.unwrap();
    assert_eq!(counts, (0, 0, 1, 0));
    let wire: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT wire FROM e2ee_key_packages WHERE reference=$1")
            .bind(&input.welcomes[0].key_package_ref)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert!(wire.is_some());
    let encoded = serde_json::to_value(receipt).unwrap();
    for field in ["commit", "tree", "welcomes", "revision", "epoch"] {
        assert!(encoded.get(field).is_none());
    }
    server.abort();
}

#[sqlx::test]
async fn real_group_submission_and_abandonment_serialize_without_spending_rejected_packages(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "group-race-owner").await;
    let guest = ready(&app, "group-race-guest").await;
    let mut accepted = 0;
    for _ in 0..6 {
        let room = room(&app, &owner, Some(&guest)).await;
        let (_, _, input) = add(&app, &owner, &guest, &room).await;
        let (submitted, settled) = tokio::join!(
            delivery::submit(&app, &owner.actor, &room.id, input.clone()),
            delivery::cancel(
                &app,
                &owner.actor,
                &room.id,
                &input.operation_id,
                input.clone()
            )
        );
        let was_accepted = match settled.unwrap() {
            wire::GroupSettlement::Accepted(value) => {
                same(&submitted.unwrap(), &value);
                accepted += 1;
                true
            }
            wire::GroupSettlement::Cancelled(_) => {
                rejected(submitted, "crypto_group_cancelled");
                rejected(
                    delivery::submit(&app, &owner.actor, &room.id, input.clone()).await,
                    "crypto_group_cancelled",
                );
                false
            }
        };
        let spent: bool =
            sqlx::query_scalar("SELECT spent FROM e2ee_key_packages WHERE reference=$1")
                .bind(&input.welcomes[0].key_package_ref)
                .fetch_one(&app.pool)
                .await
                .unwrap();
        assert_eq!(spent, was_accepted);
    }
    let counts:(i64,i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM e2ee_groups),(SELECT count(*) FROM e2ee_delivery),(SELECT count(*) FROM e2ee_group_cancellations),(SELECT count(*) FROM e2ee_key_packages WHERE spent)").fetch_one(&app.pool).await.unwrap();
    assert_eq!(counts, (accepted, accepted, 6 - accepted, accepted));
}

#[sqlx::test]
async fn group_abandonment_refuses_wrong_owner_future_certificate_scope_digests_and_reused_intent(
    pool: PgPool,
) {
    let app = App::from_pool(pool).await.unwrap();
    let owner = ready(&app, "group-negative-owner").await;
    let guest = ready(&app, "group-negative-guest").await;
    let room = room(&app, &owner, Some(&guest)).await;
    let (_, _, input) = add(&app, &owner, &guest, &room).await;
    rejected(
        delivery::cancel(
            &app,
            &guest.actor,
            &room.id,
            &input.operation_id,
            input.clone(),
        )
        .await,
        "crypto_proof_invalid",
    );
    let mut future = input.clone();
    resign(&owner, &mut future, Utc::now().timestamp() as u64 + 100);
    rejected(
        delivery::cancel(&app, &owner.actor, &room.id, &input.operation_id, future).await,
        "crypto_proof_invalid",
    );
    let mut changed = input.clone();
    changed.commit = Some(B64.encode(b"different commit"));
    rejected(
        delivery::cancel(&app, &owner.actor, &room.id, &input.operation_id, changed).await,
        "crypto_proof_invalid",
    );
    let mut changed = input.clone();
    changed.scope.data_epoch = "old-epoch".into();
    rejected(
        delivery::cancel(&app, &owner.actor, &room.id, &input.operation_id, changed).await,
        "data_epoch_changed",
    );
    abandoned(
        delivery::cancel(
            &app,
            &owner.actor,
            &room.id,
            &input.operation_id,
            input.clone(),
        )
        .await
        .unwrap(),
    );
    let mut changed = input.clone();
    changed.welcomes[0].payload.push('A');
    rejected(
        delivery::cancel(&app, &owner.actor, &room.id, &input.operation_id, changed).await,
        "operation_conflict",
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_group_cancellations")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}
