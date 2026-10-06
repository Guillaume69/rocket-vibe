use super::*;

pub(super) fn cancelled() -> Error {
    Error::new(StatusCode::CONFLICT, "crypto_group_cancelled")
}
pub(super) async fn saved_cancellation(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    device: &str,
    operation: &str,
    expected: &str,
) -> Result<Option<wire::GroupCancellation>> {
    let row:Option<(String,Json<wire::GroupCancellation>)>=sqlx::query_as("SELECT fingerprint,receipt FROM e2ee_group_cancellations WHERE user_id=$1 AND device_id=$2 AND operation_id=$3")
        .bind(&actor.id).bind(device).bind(operation).fetch_optional(&mut **tx).await?;
    match row {
        Some((original, receipt)) if original == expected => Ok(Some(receipt.0)),
        Some(_) => Err(Error::conflict()),
        None => Ok(None),
    }
}
async fn saved_decision(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    device: &str,
    operation: &str,
    fingerprint: &str,
) -> Result<Option<wire::GroupSettlement>> {
    if let Some(receipt) = saved_group(tx, actor, device, operation, fingerprint).await? {
        return Ok(Some(wire::GroupSettlement::Accepted(receipt)));
    }
    Ok(
        saved_cancellation(tx, actor, device, operation, fingerprint)
            .await?
            .map(wire::GroupSettlement::Cancelled),
    )
}
pub async fn cancel(
    app: &App,
    actor: &Account,
    room: &str,
    operation: &str,
    input: wire::GroupSubmission,
) -> Result<wire::GroupSettlement> {
    validate_scope(&input.scope, &input.operation_id)?;
    if !auth::identifier(room)
        || input.operation_id != operation
        || input.welcomes.len() > public::MAX_DEVICES
    {
        return Err(Error::invalid());
    }
    let transition = Transition::from_bytes(&decode(&input.transition, public::WIRE_LIMIT)?)
        .map_err(|_| proof())?;
    let author = &transition.certificate.device;
    if author.root.user != actor.id || transition.plan.scope.room != room {
        return Err(proof());
    }
    let device = author.device.clone();
    let scope = input.scope.clone();
    let fingerprint = intent("group_transition", &(room, &input))?;
    let mut tx = app.pool.begin().await?;
    lock_scope(&mut tx, actor, &scope).await?;
    if let Some(receipt) = saved_decision(&mut tx, actor, &device, operation, &fingerprint).await? {
        tx.commit().await?;
        return Ok(receipt);
    }
    tx.commit().await?;
    // This authenticated account abandons only its own intention namespace.
    // Historical authentication confers no admission or trust in this root.
    let checked = verify(app, move || check(input, true)).await?;
    let mut tx = app.pool.begin().await?;
    lock_scope(&mut tx, actor, &scope).await?;
    if let Some(receipt) = saved_decision(&mut tx, actor, &device, operation, &fingerprint).await? {
        tx.commit().await?;
        return Ok(receipt);
    }
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM e2ee_group_cancellations WHERE user_id=$1 AND created_at>clock_timestamp()-interval '1 day'")
        .bind(&actor.id).fetch_one(&mut *tx).await?;
    if count >= DAILY_OPERATIONS {
        return Err(Error::throttled("crypto_group_cancellation_limit", 3600));
    }
    let receipt = wire::GroupCancellation {
        scope,
        room_id: room.into(),
        incarnation: hex(&checked.transition.plan.scope.incarnation),
        operation_id: operation.into(),
        device_id: device.clone(),
        fingerprint: hex(&checked.transition.fingerprint().map_err(|_| proof())?),
    };
    sqlx::query("INSERT INTO e2ee_group_cancellations(user_id,device_id,operation_id,fingerprint,receipt) VALUES($1,$2,$3,$4,$5)")
        .bind(&actor.id).bind(&device).bind(operation).bind(fingerprint).bind(Json(&receipt)).execute(&mut *tx).await?;
    auth::lock_active(&mut tx, actor).await?;
    tx.commit().await?;
    Ok(wire::GroupSettlement::Cancelled(receipt))
}
