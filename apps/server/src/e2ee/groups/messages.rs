//! Ordered opaque application delivery. Public signature checks only; no MLS
//! private state, plaintext document, recovery secret or decrypted projection.
use super::*;
use chrono::DateTime;
use rv_crypto_public::messages as packet;

const PER_MINUTE: i32 = 600;

struct CheckedMessage {
    proof: packet::Proof,
    proof_bytes: Vec<u8>,
    ciphertext: Vec<u8>,
}
fn check_message(input: wire::ApplicationSubmission, historical: bool) -> Result<CheckedMessage> {
    let proof_bytes = decode(&input.proof, packet::PROOF_LIMIT)?;
    let ciphertext = decode(&input.ciphertext, packet::CIPHERTEXT_LIMIT)?;
    if B64.encode(&proof_bytes) != input.proof || B64.encode(&ciphertext) != input.ciphertext {
        return Err(proof());
    }
    let claim = packet::Proof::from_bytes(&proof_bytes).map_err(|_| proof())?;
    let now = Utc::now().timestamp() as u64;
    if historical {
        claim.authenticate(&ciphertext).map_err(|_| proof())?;
        if now < claim.certificate.device.issued_at {
            return Err(proof());
        }
    } else {
        claim.verify(now, &ciphertext).map_err(|_| proof())?;
    }
    if claim.header.scope.instance != input.scope.instance_id
        || claim.header.scope.data_epoch != input.scope.data_epoch
        || claim.header.operation != input.operation_id
    {
        return Err(proof());
    }
    Ok(CheckedMessage {
        proof: claim,
        proof_bytes,
        ciphertext,
    })
}
async fn saved_message(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    operation: &str,
    expected: &str,
) -> Result<Option<wire::ApplicationReceipt>> {
    let row: Option<(String, Json<wire::ApplicationReceipt>)> = sqlx::query_as("SELECT fingerprint,receipt FROM e2ee_application_messages WHERE user_id=$1 AND operation_id=$2")
        .bind(&actor.id).bind(operation).fetch_optional(&mut **tx).await?;
    match row {
        Some((original, receipt)) if original == expected => Ok(Some(receipt.0)),
        Some(_) => Err(Error::conflict()),
        None => Ok(None),
    }
}
fn cancelled() -> Error {
    Error::new(StatusCode::CONFLICT, "crypto_message_cancelled")
}
async fn saved_cancellation(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    operation: &str,
    expected: &str,
) -> Result<Option<wire::ApplicationCancellation>> {
    let row: Option<(String, Json<wire::ApplicationCancellation>)> = sqlx::query_as(
        "SELECT fingerprint,receipt FROM e2ee_message_cancellations WHERE user_id=$1 AND operation_id=$2")
        .bind(&actor.id).bind(operation).fetch_optional(&mut **tx).await?;
    match row {
        Some((original, receipt)) if original == expected => Ok(Some(receipt.0)),
        Some(_) => Err(Error::conflict()),
        None => Ok(None),
    }
}
async fn ordinary_operation_used(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    operation: &str,
) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM messages WHERE author_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_creation_requests WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM message_actions WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM room_commands WHERE user_id=$1 AND operation_id=$2) OR EXISTS(SELECT 1 FROM uploads WHERE user_id=$1 AND operation_id=$2)")
        .bind(&actor.id).bind(operation).fetch_one(&mut **tx).await?)
}
async fn message_budget(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    device: &str,
) -> Result<()> {
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO e2ee_message_budgets(user_id,device_id,window_start,used) VALUES($1,$2,$3,0) ON CONFLICT DO NOTHING")
        .bind(&actor.id).bind(device).bind(now).execute(&mut **tx).await?;
    let (mut start, mut used): (DateTime<Utc>,i32) = sqlx::query_as("SELECT window_start,used FROM e2ee_message_budgets WHERE user_id=$1 AND device_id=$2 FOR UPDATE")
        .bind(&actor.id).bind(device).fetch_one(&mut **tx).await?;
    if now >= start + chrono::Duration::minutes(1) {
        start = now;
        used = 0;
    }
    if now < start {
        return Err(Error::throttled("crypto_message_limit", 60));
    }
    if used >= PER_MINUTE {
        return Err(Error::throttled(
            "crypto_message_limit",
            ((start + chrono::Duration::minutes(1) - now)
                .num_milliseconds()
                .max(1) as u64)
                .div_ceil(1000),
        ));
    }
    sqlx::query(
        "UPDATE e2ee_message_budgets SET window_start=$3,used=$4 WHERE user_id=$1 AND device_id=$2",
    )
    .bind(&actor.id)
    .bind(device)
    .bind(start)
    .bind(used + 1)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
fn current_scope(head: &Head, scope: &wire::Scope) -> Result<()> {
    if head.data_epoch != scope.data_epoch
        || head.receipt.scope.instance_id != scope.instance_id
        || head.receipt.scope.data_epoch != scope.data_epoch
    {
        return Err(stale());
    }
    Ok(())
}
fn head_matches(header: &packet::Header, head: &Head) -> Result<()> {
    if header.scope.incarnation.iter().all(|b| *b == 0)
        || hex(&header.scope.incarnation) != head.incarnation
        || header.group_revision != head.revision as u64
        || header.epoch != head.epoch as u64
        || hex(&header.group_fingerprint) != head.fingerprint
    {
        return Err(stale());
    }
    Ok(())
}

pub async fn submit(
    app: &App,
    actor: &Account,
    room: &str,
    input: wire::ApplicationSubmission,
) -> Result<wire::ApplicationReceipt> {
    validate_scope(&input.scope, &input.operation_id)?;
    if !auth::identifier(room)
        || input.proof.len() > packet::PROOF_LIMIT.div_ceil(3) * 4
        || input.ciphertext.len() > packet::CIPHERTEXT_LIMIT.div_ceil(3) * 4
    {
        return Err(Error::invalid());
    }
    let fingerprint = intent("application_message", &(room, &input))?;
    let mut tx = app.pool.begin().await?;
    let (device, _) = lock_scope(&mut tx, actor, &input.scope).await?;
    let previous = saved_message(&mut tx, actor, &input.operation_id, &fingerprint).await?;
    if saved_cancellation(&mut tx, actor, &input.operation_id, &fingerprint)
        .await?
        .is_some()
    {
        return Err(cancelled());
    }
    if previous.is_none() {
        room_lock(&mut tx, actor, room, false).await?;
    }
    tx.commit().await?;
    if let Some(receipt) = previous {
        return Ok(receipt);
    }
    let scope = input.scope.clone();
    let operation = input.operation_id.clone();
    let checked = verify(app, move || check_message(input, false)).await?;
    let header = &checked.proof.header;
    if header.scope.room != room || header.author != actor.id || header.device != device {
        return Err(proof());
    }
    let mut tx = app.pool.begin().await?;
    let (device, _) = lock_scope(&mut tx, actor, &scope).await?;
    if saved_cancellation(&mut tx, actor, &operation, &fingerprint)
        .await?
        .is_some()
    {
        return Err(cancelled());
    }
    if let Some(receipt) = saved_message(&mut tx, actor, &operation, &fingerprint).await? {
        tx.commit().await?;
        return Ok(receipt);
    }
    // Read a candidate plan before acquiring its peer activation fences. The
    // subsequent exclusive room lock and exact head comparison reject a race.
    let candidate = head(&mut tx, room).await?.ok_or_else(Error::missing)?;
    current_scope(&candidate, &scope)?;
    head_matches(header, &candidate)?;
    let plan = Transition::from_bytes(&candidate.transition)
        .map_err(|_| Error::internal())?
        .plan;
    lock_activations(&mut tx, &plan.members).await?;
    let (_, authority) = room_lock(&mut tx, actor, room, true).await?;
    let current = head(&mut tx, room).await?.ok_or_else(Error::missing)?;
    current_scope(&current, &scope)?;
    head_matches(header, &current)?;
    let participant = plan
        .participants
        .iter()
        .find(|p| p.user == actor.id && p.device == device)
        .ok_or_else(proof)?;
    if participant.incarnation != header.incarnation
        || participant.certificate != header.certificate
        || participant.root
            != checked
                .proof
                .certificate
                .device
                .root
                .fingerprint()
                .map_err(|_| proof())?
    {
        return Err(proof());
    }
    lock_fences(&mut tx, plan.participants.clone().into_iter()).await?;
    crate::permissions::require_send(&mut tx, room, &actor.id).await?;
    let now: i64 =
        sqlx::query_scalar("SELECT floor(EXTRACT(EPOCH FROM clock_timestamp()))::bigint")
            .fetch_one(&mut *tx)
            .await?;
    roster(&mut tx, &plan, &authority, now).await?;
    if ordinary_operation_used(&mut tx, actor, &operation).await? {
        return Err(Error::conflict());
    }
    if let Some(root) = &header.thread {
        let visible: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM e2ee_application_messages m JOIN e2ee_group_recipients r ON r.room_id=m.room_id AND r.revision=m.group_revision WHERE m.id=$1 AND m.room_id=$2 AND m.thread_root IS NULL AND r.device_id=$3 AND r.witness=$4)")
            .bind(root).bind(room).bind(&device).bind(Json(admission_witness(&plan, participant)?)).fetch_one(&mut *tx).await?;
        if !visible {
            return Err(Error::new(StatusCode::BAD_REQUEST, "invalid_thread_root"));
        }
    }
    message_budget(&mut tx, actor, &device).await?;
    let position = crate::store::next_position(&mut tx).await?;
    let id = auth::random_token()[..24].to_owned();
    let receipt = wire::ApplicationReceipt {
        scope,
        room_id: room.into(),
        operation_id: operation.clone(),
        header: B64.encode(&serde_json::to_vec(header).map_err(|_| Error::internal())?),
        fingerprint: hex(&checked.proof.fingerprint().map_err(|_| proof())?),
        message_id: id.clone(),
        position: position.to_string(),
    };
    sqlx::query("INSERT INTO e2ee_application_messages(id,room_id,group_revision,user_id,device_id,operation_id,fingerprint,proof,ciphertext,receipt,thread_root) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)")
        .bind(&id).bind(room).bind(header.group_revision as i64).bind(&actor.id).bind(&device).bind(&operation).bind(fingerprint).bind(checked.proof_bytes).bind(checked.ciphertext).bind(Json(&receipt)).bind(&header.thread).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO e2ee_delivery(position,room_id,group_revision,message_id) VALUES($1,$2,$3,$4)",
    )
    .bind(position)
    .bind(room)
    .bind(header.group_revision as i64)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    auth::lock_active(&mut tx, actor).await?;
    let final_now: i64 =
        sqlx::query_scalar("SELECT floor(EXTRACT(EPOCH FROM clock_timestamp()))::bigint")
            .fetch_one(&mut *tx)
            .await?;
    let deadline = roster(&mut tx, &plan, &authority, final_now).await?;
    if final_now >= deadline
        || final_now < checked.proof.certificate.device.issued_at as i64
        || final_now >= checked.proof.certificate.device.expires_at as i64
    {
        return Err(wait());
    }
    publish_activity(&mut tx, room, position).await?;
    tx.commit().await?;
    Ok(receipt)
}

/// Explicit abandonment is a terminal decision, not an inference from a 404
/// or a transient error. Author serialization fences any late original POST.
/// An accepted send always wins and is returned unchanged, even after withdrawal.
pub async fn cancel(
    app: &App,
    actor: &Account,
    room: &str,
    operation: &str,
    input: wire::ApplicationSubmission,
) -> Result<wire::ApplicationSettlement> {
    validate_scope(&input.scope, &input.operation_id)?;
    if !auth::identifier(room)
        || input.operation_id != operation
        || input.proof.len() > packet::PROOF_LIMIT.div_ceil(3) * 4
        || input.ciphertext.len() > packet::CIPHERTEXT_LIMIT.div_ceil(3) * 4
    {
        return Err(Error::invalid());
    }
    let fingerprint = intent("application_message", &(room, &input))?;
    let scope = input.scope.clone();
    let mut tx = app.pool.begin().await?;
    lock_scope(&mut tx, actor, &scope).await?;
    if let Some(receipt) = saved_message(&mut tx, actor, operation, &fingerprint).await? {
        tx.commit().await?;
        return Ok(wire::ApplicationSettlement::Accepted(receipt));
    }
    if let Some(receipt) = saved_cancellation(&mut tx, actor, operation, &fingerprint).await? {
        tx.commit().await?;
        return Ok(wire::ApplicationSettlement::Cancelled(receipt));
    }
    tx.commit().await?;
    // No certificate lifetime/room access is granted by authentication here:
    // cancellation changes only this HTTP account's own operation namespace.
    let checked = verify(app, move || check_message(input, true)).await?;
    if checked.proof.header.author != actor.id || checked.proof.header.scope.room != room {
        return Err(proof());
    }
    let mut tx = app.pool.begin().await?;
    lock_scope(&mut tx, actor, &scope).await?;
    if let Some(receipt) = saved_message(&mut tx, actor, operation, &fingerprint).await? {
        tx.commit().await?;
        return Ok(wire::ApplicationSettlement::Accepted(receipt));
    }
    if let Some(receipt) = saved_cancellation(&mut tx, actor, operation, &fingerprint).await? {
        tx.commit().await?;
        return Ok(wire::ApplicationSettlement::Cancelled(receipt));
    }
    if ordinary_operation_used(&mut tx, actor, operation).await? {
        return Err(Error::conflict());
    }
    let recent: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_message_cancellations WHERE user_id=$1 AND created_at>clock_timestamp()-interval '1 minute'")
        .bind(&actor.id).fetch_one(&mut *tx).await?;
    if recent >= 600 {
        return Err(Error::throttled("crypto_cancellation_limit", 60));
    }
    let receipt = wire::ApplicationCancellation {
        scope,
        room_id: room.into(),
        operation_id: operation.into(),
        header: B64
            .encode(&serde_json::to_vec(&checked.proof.header).map_err(|_| Error::internal())?),
        fingerprint: hex(&checked.proof.fingerprint().map_err(|_| proof())?),
    };
    sqlx::query("INSERT INTO e2ee_message_cancellations(user_id,operation_id,fingerprint,receipt) VALUES($1,$2,$3,$4)")
        .bind(&actor.id).bind(operation).bind(fingerprint).bind(Json(&receipt)).execute(&mut *tx).await?;
    auth::lock_active(&mut tx, actor).await?;
    tx.commit().await?;
    Ok(wire::ApplicationSettlement::Cancelled(receipt))
}

/// Personal historical ACK: room withdrawal or certificate expiry cannot turn
/// an accepted own operation into an uncertain send. No ciphertext is returned.
pub async fn operation(
    app: &App,
    actor: &Account,
    room: &str,
    operation: &str,
) -> Result<Response> {
    if !auth::identifier(room) || !auth::identifier(operation) {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    let (instance_id, data_epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton")
            .fetch_one(&mut *tx)
            .await?;
    let scope = wire::Scope {
        instance_id,
        data_epoch,
    };
    lock_scope(&mut tx, actor, &scope).await?;
    let row: Option<Json<wire::ApplicationReceipt>> = sqlx::query_scalar("SELECT receipt FROM e2ee_application_messages WHERE user_id=$1 AND operation_id=$2 AND room_id=$3")
        .bind(&actor.id).bind(operation).bind(room).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        let cancellation: Option<Json<wire::ApplicationCancellation>> = sqlx::query_scalar(
            "SELECT receipt FROM e2ee_message_cancellations WHERE user_id=$1 AND operation_id=$2",
        )
        .bind(&actor.id)
        .bind(operation)
        .fetch_optional(&mut *tx)
        .await?;
        if cancellation.is_some_and(|r| {
            r.0.room_id == room
                && r.0.scope.instance_id == scope.instance_id
                && r.0.scope.data_epoch == scope.data_epoch
        }) {
            return Err(cancelled());
        }
        return Err(Error::missing());
    };
    let receipt = row.0;
    if receipt.scope.instance_id != scope.instance_id
        || receipt.scope.data_epoch != scope.data_epoch
    {
        return Err(stale());
    }
    let session: DateTime<Utc> =
        sqlx::query_scalar("SELECT expires_at FROM sessions WHERE token_hash=$1")
            .bind(&actor.session_hash)
            .fetch_one(&mut *tx)
            .await?;
    response(&receipt, tx, monotonic_deadline(session)?)
}

#[derive(sqlx::FromRow)]
struct EventRow {
    position: i64,
    message_id: Option<String>,
    transition: Vec<u8>,
    commit: Option<Vec<u8>>,
    group_receipt: Json<wire::GroupReceipt>,
    welcome_incarnation: Option<String>,
    key_package_ref: Option<String>,
    welcome: Option<Vec<u8>>,
    message_receipt: Option<Json<wire::ApplicationReceipt>>,
    proof: Option<Vec<u8>>,
    ciphertext: Option<Vec<u8>>,
}
/// Ordinary quote commands have already locked the actor/session and all
/// source/destination rooms. Reuse private delivery's current reader and exact
/// admission witness; only the historical position leaves this function.
pub(crate) async fn quote_revision(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    room: &str,
    message: &str,
) -> Result<Option<i64>> {
    let Some(head) = head(tx, room).await? else {
        return Ok(None);
    };
    crate::store::require_member(tx, room, &actor.id).await?;
    let (instance_id, data_epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton")
            .fetch_one(&mut **tx)
            .await?;
    current_scope(
        &head,
        &wire::Scope {
            instance_id,
            data_epoch,
        },
    )?;
    let plan = Transition::from_bytes(&head.transition)
        .map_err(|_| Error::internal())?
        .plan;
    let (device, expires): (String, DateTime<Utc>) =
        sqlx::query_as("SELECT device_id,expires_at FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>clock_timestamp()")
            .bind(&actor.session_hash).bind(&actor.id).fetch_optional(&mut **tx).await?
            .ok_or_else(Error::unauthorized)?;
    let now: i64 =
        sqlx::query_scalar("SELECT floor(EXTRACT(EPOCH FROM clock_timestamp()))::bigint")
            .fetch_one(&mut **tx)
            .await?;
    let (_, deadline) =
        reader(tx, actor, &device, &plan, now, monotonic_deadline(expires)?).await?;
    let participant = plan
        .participants
        .iter()
        .find(|p| p.user == actor.id && p.device == device)
        .ok_or_else(Error::forbidden)?;
    let witness = admission_witness(&plan, participant)?;
    let revision = sqlx::query_scalar("SELECT d.position FROM e2ee_application_messages m JOIN e2ee_delivery d ON d.message_id=m.id AND d.room_id=m.room_id JOIN e2ee_group_recipients r ON r.room_id=m.room_id AND r.revision=m.group_revision WHERE m.id=$1 AND m.room_id=$2 AND r.device_id=$3 AND r.witness=$4")
        .bind(message).bind(room).bind(device).bind(Json(witness)).fetch_optional(&mut **tx).await?;
    if Instant::now() >= deadline {
        return Err(Error::unauthorized());
    }
    Ok(revision)
}
pub async fn delivery(
    app: &App,
    actor: &Account,
    room: &str,
    after: Option<&str>,
    through: Option<&str>,
) -> Result<Response> {
    let after = after.map(decimal).transpose()?.unwrap_or(0);
    let requested = through.map(decimal).transpose()?;
    let ReadAccess {
        mut tx,
        device,
        scope,
        now,
        deadline,
        ..
    } = read_lock(app, actor, room).await?;
    let head = head(&mut tx, room).await?.ok_or_else(Error::missing)?;
    current_scope(&head, &scope)?;
    let plan = Transition::from_bytes(&head.transition)
        .map_err(|_| Error::internal())?
        .plan;
    let (access, remaining) = reader(&mut tx, actor, &device, &plan, now, deadline).await?;
    let participant = plan
        .participants
        .iter()
        .find(|p| p.user == actor.id && p.device == device)
        .ok_or_else(Error::forbidden)?;
    let witness = admission_witness(&plan, participant)?;
    let maximum: i64 =
        sqlx::query_scalar("SELECT COALESCE(max(position),0) FROM e2ee_delivery WHERE room_id=$1")
            .bind(room)
            .fetch_one(&mut *tx)
            .await?;
    let through = requested.unwrap_or(maximum);
    if after > through || through > maximum {
        return Err(Error::invalid());
    }
    let rows: Vec<EventRow> = sqlx::query_as("SELECT d.position,d.message_id,CASE WHEN d.message_id IS NULL THEN e.transition ELSE decode('','hex') END AS transition,CASE WHEN d.message_id IS NULL THEN e.commit ELSE NULL END AS commit,e.receipt AS group_receipt,w.incarnation AS welcome_incarnation,w.key_package_ref,w.payload AS welcome,m.receipt AS message_receipt,m.proof,m.ciphertext FROM e2ee_delivery d JOIN e2ee_group_recipients r ON r.room_id=d.room_id AND r.revision=d.group_revision AND r.device_id=$2 AND r.witness=$3 JOIN e2ee_group_events e ON e.room_id=d.room_id AND e.revision=d.group_revision LEFT JOIN e2ee_group_welcomes w ON d.message_id IS NULL AND w.room_id=d.room_id AND w.revision=d.group_revision AND w.device_id=$2 AND w.incarnation=$4 AND w.access_version=$5 LEFT JOIN e2ee_application_messages m ON m.id=d.message_id WHERE d.room_id=$1 AND d.position>$6 AND d.position<=$7 ORDER BY d.position LIMIT 17")
        .bind(room).bind(&device).bind(Json(witness)).bind(hex(&participant.incarnation)).bind(access).bind(after).bind(through).fetch_all(&mut *tx).await?;
    let mut events = Vec::new();
    let mut bytes = 0;
    let mut has_more = false;
    for row in rows {
        let size = if row.message_id.is_some() {
            row.proof.as_ref().map_or(0, Vec::len) + row.ciphertext.as_ref().map_or(0, Vec::len)
        } else {
            row.transition.len()
                + row.commit.as_ref().map_or(0, Vec::len)
                + row.welcome.as_ref().map_or(0, Vec::len)
        };
        if events.len() == 16 || !events.is_empty() && bytes + size > TOTAL {
            has_more = true;
            break;
        }
        let content = if let Some(id) = row.message_id {
            let receipt = row.message_receipt.ok_or_else(Error::internal)?.0;
            if receipt.message_id != id || receipt.position != row.position.to_string() {
                return Err(Error::internal());
            }
            wire::DeliveryContent::Message(wire::ApplicationMessage {
                receipt,
                proof: B64.encode(&row.proof.ok_or_else(Error::internal)?),
                ciphertext: B64.encode(&row.ciphertext.ok_or_else(Error::internal)?),
            })
        } else {
            let welcome = match (row.welcome_incarnation, row.key_package_ref, row.welcome) {
                (Some(incarnation), Some(key_package_ref), Some(payload)) => {
                    Some(wire::GroupWelcome {
                        device_id: device.clone(),
                        incarnation,
                        key_package_ref,
                        payload: B64.encode(&payload),
                    })
                }
                (None, None, None) => None,
                _ => return Err(Error::internal()),
            };
            wire::DeliveryContent::Group(wire::GroupEvent {
                receipt: row.group_receipt.0,
                transition: B64.encode(&row.transition),
                commit: row.commit.map(|v| B64.encode(&v)),
                welcome,
            })
        };
        bytes += size;
        events.push(wire::DeliveryEvent {
            position: row.position.to_string(),
            content,
        });
    }
    let next = if has_more {
        events.last().map(|e| e.position.clone())
    } else {
        None
    };
    response(
        &wire::DeliveryPage {
            scope,
            room_id: room.into(),
            incarnation: head.incarnation,
            after: after.to_string(),
            through: through.to_string(),
            events,
            next,
        },
        tx,
        remaining,
    )
}
