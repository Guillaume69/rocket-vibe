//! Atomic, signed MLS delivery transitions. The server never processes an MLS
//! private state; recipients independently validate MLS, pins and group policy.
use super::*;
use axum::{body::Bytes, response::Response};
use rv_crypto_public::Fingerprint;
use rv_crypto_public::groups::{self as public, Participant, Transition};
use sqlx::types::Json;
use std::time::Instant;

const PAYLOAD: usize = 1024 * 1024;
const TOTAL: usize = 2 * 1024 * 1024;
pub mod messages;
mod settlement;
pub use settlement::cancel;
fn stale() -> Error {
    Error::new(StatusCode::CONFLICT, "crypto_group_changed")
}
fn wait() -> Error {
    Error::new(StatusCode::CONFLICT, "crypto_rekey_required")
}

/// Call while holding the room lock. A group starts only before any ordinary
/// content, and subsequent legacy text/file writes must never leak plaintext.
pub(crate) async fn require_plaintext(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
) -> Result<()> {
    let encrypted: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM e2ee_groups WHERE room_id=$1)")
            .bind(room)
            .fetch_one(&mut **tx)
            .await?;
    if encrypted {
        return Err(Error::new(StatusCode::CONFLICT, "crypto_required"));
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct AdmissionPackage {
    user_id: String,
    device_id: String,
    incarnation: String,
    wire: Option<Vec<u8>>,
    expires_at: i64,
    spent: bool,
}

#[derive(sqlx::FromRow)]
struct RosterDevice {
    user_id: String,
    incarnation: String,
    certificate: Vec<u8>,
    fingerprint: String,
    expires_at: i64,
    retired: bool,
    session_deadline: i64,
}

#[derive(sqlx::FromRow)]
struct Head {
    data_epoch: String,
    incarnation: String,
    revision: i64,
    epoch: i64,
    fingerprint: String,
    transition: Vec<u8>,
    tree: Vec<u8>,
    receipt: Json<wire::GroupReceipt>,
}
async fn head(tx: &mut Transaction<'_, Postgres>, room: &str) -> Result<Option<Head>> {
    Ok(sqlx::query_as("SELECT data_epoch,incarnation,revision,epoch,fingerprint,transition,tree,receipt FROM e2ee_groups WHERE room_id=$1")
        .bind(room).fetch_optional(&mut **tx).await?)
}
async fn room_lock(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    room: &str,
    write: bool,
) -> Result<(String, String)> {
    let query = if write {
        "SELECT kind,authority_version FROM rooms WHERE id=$1 FOR UPDATE"
    } else {
        "SELECT kind,authority_version FROM rooms WHERE id=$1 FOR SHARE"
    };
    let row: Option<(String, String)> = sqlx::query_as(query)
        .bind(room)
        .fetch_optional(&mut **tx)
        .await?;
    let row = row.ok_or_else(Error::missing)?;
    crate::store::require_member(tx, room, &actor.id).await?;
    Ok(row)
}
async fn saved_group(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    device: &str,
    operation: &str,
    fingerprint: &str,
) -> Result<Option<wire::GroupReceipt>> {
    let row:Option<(String,Json<wire::GroupReceipt>)>=sqlx::query_as("SELECT fingerprint,result FROM e2ee_group_operations WHERE user_id=$1 AND device_id=$2 AND operation_id=$3")
        .bind(&actor.id).bind(device).bind(operation).fetch_optional(&mut **tx).await?;
    match row {
        Some((old, value)) if old == fingerprint => Ok(Some(value.0)),
        Some(_) => Err(Error::conflict()),
        None => Ok(None),
    }
}
async fn lock_fences(
    tx: &mut Transaction<'_, Postgres>,
    participants: impl Iterator<Item = Participant>,
) -> Result<()> {
    let mut keys = BTreeSet::new();
    for participant in participants {
        keys.insert((participant.device, hex(&participant.incarnation)));
    }
    for (device, incarnation) in keys {
        let found:Option<bool>=sqlx::query_scalar("SELECT retired FROM e2ee_device_fences WHERE device_id=$1 AND incarnation=$2 FOR SHARE")
            .bind(device).bind(incarnation).fetch_optional(&mut **tx).await?;
        if found.is_none() {
            return Err(stale());
        }
    }
    Ok(())
}
async fn roster(
    tx: &mut Transaction<'_, Postgres>,
    plan: &public::Plan,
    authority: &str,
    now: i64,
) -> Result<i64> {
    if authority != plan.authority_version {
        return Err(wait());
    }
    let members = current_members(tx, &plan.scope.room).await?;
    if members != plan.members {
        return Err(wait());
    }
    let mut deadline = i64::MAX;
    for participant in &plan.participants {
        let row:Option<RosterDevice>=sqlx::query_as("SELECT d.user_id,d.incarnation,d.certificate,i.fingerprint,d.expires_at,f.retired,floor(EXTRACT(EPOCH FROM s.expires_at))::bigint AS session_deadline FROM e2ee_devices d JOIN e2ee_identities i ON i.user_id=d.user_id JOIN e2ee_device_fences f ON f.device_id=d.device_id AND f.incarnation=d.incarnation JOIN LATERAL (SELECT max(expires_at) AS expires_at FROM sessions WHERE device_id=d.device_id) s ON s.expires_at>clock_timestamp() WHERE d.device_id=$1")
            .bind(&participant.device).fetch_optional(&mut **tx).await?;
        let Some(RosterDevice {
            user_id: user,
            incarnation,
            certificate,
            fingerprint: root,
            expires_at: expires,
            retired,
            session_deadline,
        }) = row
        else {
            return Err(wait());
        };
        let certificate: Certificate =
            serde_json::from_slice(&certificate).map_err(|_| Error::internal())?;
        if user != participant.user
            || incarnation != hex(&participant.incarnation)
            || root != hex(&participant.root)
            || certificate.fingerprint().map_err(|_| proof())? != participant.certificate
            || expires <= now
            || retired
        {
            return Err(wait());
        }
        deadline = deadline.min(expires).min(session_deadline);
    }
    Ok(deadline)
}
async fn current_members(
    tx: &mut Transaction<'_, Postgres>,
    room: &str,
) -> Result<Vec<public::Member>> {
    // One statement snapshot, also used by transition validation. An extra row
    // detects overflow; never let a partial page masquerade as a complete plan.
    let rows:Vec<(String,String,String)>=sqlx::query_as("SELECT m.user_id,m.access_version,u.activation_version FROM members m JOIN users u ON u.id=m.user_id WHERE m.room_id=$1 AND NOT u.disabled ORDER BY m.user_id LIMIT $2")
        .bind(room).bind(public::MAX_MEMBERS as i64 + 1).fetch_all(&mut **tx).await?;
    Ok(rows
        .into_iter()
        .map(
            |(user, access_version, activation_version)| public::Member {
                user,
                access_version,
                activation_version,
            },
        )
        .collect())
}

// Compatible with ordinary per-author NO KEY UPDATE, but blocks activation-key
// changes. Take these before room locks so a disabling operator cannot form a
// peer-user / room cycle with a crypto publisher.
async fn lock_activations(
    tx: &mut Transaction<'_, Postgres>,
    members: &[public::Member],
) -> Result<()> {
    let users: Vec<_> = members.iter().map(|m| m.user.clone()).collect();
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT id,activation_version FROM users WHERE id=ANY($1) AND NOT disabled ORDER BY id FOR KEY SHARE")
        .bind(users).fetch_all(&mut **tx).await?;
    if rows.len() != members.len()
        || rows.iter().zip(members).any(|((user, version), member)| {
            user != &member.user || version != &member.activation_version
        })
    {
        return Err(wait());
    }
    Ok(())
}

fn admission_witness(plan: &public::Plan, participant: &Participant) -> Result<serde_json::Value> {
    let member = plan
        .members
        .iter()
        .find(|m| m.user == participant.user)
        .ok_or_else(proof)?;
    Ok(serde_json::json!([
        plan.scope,
        participant.user,
        participant.device,
        participant.incarnation,
        participant.root,
        participant.leaf,
        participant.key_package,
        member.access_version,
        member.activation_version
    ]))
}
fn same_admission(old: &public::Plan, new: &public::Plan, p: &Participant) -> bool {
    let member = |plan: &public::Plan| plan.members.iter().find(|m| m.user == p.user).cloned();
    member(old) == member(new)
        && old.participants.iter().any(|v| {
            v.device == p.device
                && v.incarnation == p.incarnation
                && v.user == p.user
                && v.root == p.root
                && v.leaf == p.leaf
                && v.key_package == p.key_package
        })
}
struct Checked {
    transition: Transition,
    bytes: Vec<u8>,
    commit: Option<Vec<u8>>,
    tree: Vec<u8>,
    welcomes: Vec<(wire::GroupWelcome, Vec<u8>)>,
}
fn check(input: wire::GroupSubmission, historical: bool) -> Result<Checked> {
    let bytes = decode(&input.transition, public::WIRE_LIMIT)?;
    let transition = Transition::from_bytes(&bytes).map_err(|_| proof())?;
    let now = Utc::now().timestamp() as u64;
    if historical {
        transition.authenticate().map_err(|_| proof())?;
        if now < transition.certificate.device.issued_at {
            return Err(proof());
        }
    } else {
        transition.verify(now).map_err(|_| proof())?;
    }
    if transition.plan.scope.instance != input.scope.instance_id
        || transition.plan.scope.data_epoch != input.scope.data_epoch
        || transition.plan.operation != input.operation_id
    {
        return Err(proof());
    }
    let digest = |b: &[u8]| -> Fingerprint {
        data_encoding::HEXLOWER
            .decode(auth::hash_token_bytes(b).as_bytes())
            .expect("SHA256 hex")
            .try_into()
            .expect("SHA256 bytes")
    };
    let commit = input
        .commit
        .as_ref()
        .map(|v| decode(v, PAYLOAD))
        .transpose()?;
    let tree = decode(&input.tree, PAYLOAD)?;
    if tree.is_empty()
        || digest(&tree) != transition.plan.tree
        || commit.as_ref().map(|b| digest(b)) != transition.plan.commit
    {
        return Err(proof());
    }
    if input.welcomes.len() != transition.plan.welcomes.len() {
        return Err(proof());
    }
    let mut total = tree.len() + commit.as_ref().map_or(0, Vec::len);
    let mut welcomes = Vec::new();
    for (wire, claim) in input.welcomes.into_iter().zip(&transition.plan.welcomes) {
        let payload = decode(&wire.payload, PAYLOAD)?;
        total += payload.len();
        if wire.device_id != claim.device
            || wire.incarnation != hex(&claim.incarnation)
            || wire.key_package_ref != B64.encode(&claim.key_package)
            || payload.is_empty()
            || digest(&payload) != claim.digest
        {
            return Err(proof());
        }
        welcomes.push((wire, payload));
    }
    if total > TOTAL {
        return Err(Error::invalid());
    }
    Ok(Checked {
        transition,
        bytes,
        commit,
        tree,
        welcomes,
    })
}

pub async fn submit(
    app: &App,
    actor: &Account,
    room: &str,
    input: wire::GroupSubmission,
) -> Result<wire::GroupReceipt> {
    validate_scope(&input.scope, &input.operation_id)?;
    if !auth::identifier(room) || input.welcomes.len() > public::MAX_DEVICES {
        return Err(Error::invalid());
    }
    let fingerprint = intent("group_transition", &(room, &input))?;
    let mut tx = app.pool.begin().await?;
    let (device, _) = lock_scope(&mut tx, actor, &input.scope).await?;
    let previous = saved_group(&mut tx, actor, &device, &input.operation_id, &fingerprint).await?;
    if previous.is_none() {
        if settlement::saved_cancellation(
            &mut tx,
            actor,
            &device,
            &input.operation_id,
            &fingerprint,
        )
        .await?
        .is_some()
        {
            return Err(settlement::cancelled());
        }
        room_lock(&mut tx, actor, room, true).await?;
    }
    tx.commit().await?;
    if let Some(receipt) = previous {
        return Ok(receipt);
    }
    let scope = input.scope.clone();
    let operation = input.operation_id.clone();
    let checked = verify(app, move || check(input, false)).await?;
    let plan = &checked.transition.plan;
    let author = &checked.transition.certificate.device;
    if plan.scope.room != room || author.root.user != actor.id || author.device != device {
        return Err(proof());
    }
    let mut tx = app.pool.begin().await?;
    let (device, _) = lock_scope(&mut tx, actor, &scope).await?;
    if let Some(receipt) = saved_group(&mut tx, actor, &device, &operation, &fingerprint).await? {
        tx.commit().await?;
        return Ok(receipt);
    }
    if settlement::saved_cancellation(&mut tx, actor, &device, &operation, &fingerprint)
        .await?
        .is_some()
    {
        return Err(settlement::cancelled());
    }
    lock_activations(&mut tx, &plan.members).await?;
    let (kind, authority) = room_lock(&mut tx, actor, room, true).await?;
    let old = head(&mut tx, room).await?;
    let old_plan = old
        .as_ref()
        .map(|h| {
            Transition::from_bytes(&h.transition)
                .map(|v| v.plan)
                .map_err(|_| Error::internal())
        })
        .transpose()?;
    match &old {
        Some(head)
            if head.data_epoch == scope.data_epoch
                && head.incarnation == hex(&plan.scope.incarnation)
                && head.revision as u64 == plan.expected_revision
                && Some(head.epoch as u64) == plan.expected_epoch
                && head.fingerprint == hex(&plan.previous) => {}
        None if plan.expected_revision == 0 => {
            let role = crate::store::require_member(&mut tx, room, &actor.id).await?;
            if kind != "direct" && role != "owner" {
                return Err(Error::forbidden());
            }
            let has_history: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM messages WHERE room_id=$1 AND system IS NULL) OR EXISTS(SELECT 1 FROM uploads WHERE room_id=$1 AND state IN ('prepared','ready') AND expires_at>clock_timestamp())",
            )
            .bind(room)
            .fetch_one(&mut *tx)
            .await?;
            if has_history {
                return Err(Error::new(StatusCode::CONFLICT, "crypto_room_has_history"));
            }
        }
        _ => return Err(stale()),
    }
    let actor_entry = plan
        .participants
        .iter()
        .find(|p| p.device == device)
        .ok_or_else(proof)?;
    if old_plan
        .as_ref()
        .is_some_and(|old| !same_admission(old, plan, actor_entry))
    {
        return Err(Error::forbidden());
    }
    lock_fences(
        &mut tx,
        old_plan
            .as_ref()
            .into_iter()
            .flat_map(|p| p.participants.clone())
            .chain(plan.participants.clone()),
    )
    .await?;
    let now: i64 =
        sqlx::query_scalar("SELECT floor(EXTRACT(EPOCH FROM clock_timestamp()))::bigint")
            .fetch_one(&mut *tx)
            .await?;
    if now >= author.expires_at as i64 || now < author.issued_at as i64 {
        return Err(proof());
    }
    roster(&mut tx, plan, &authority, now).await?;
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM e2ee_group_operations WHERE user_id=$1 AND device_id=$2 AND created_at>clock_timestamp()-interval '1 day'")
        .bind(&actor.id).bind(&device).fetch_one(&mut *tx).await?;
    if count >= DAILY_OPERATIONS {
        return Err(Error::throttled("crypto_group_operation_limit", 3600));
    }
    let group = hex(&plan.scope.group_id().map_err(|_| proof())?);
    let mut admitted = BTreeSet::new();
    // Sorted locks on new refs. Permanent device fences already serialize
    // registration/revocation, including the bootstrap leaf without a package.
    let mut new_refs = BTreeSet::new();
    let mut admission_deadline = i64::MAX;
    for p in &plan.participants {
        if old_plan
            .as_ref()
            .is_some_and(|old| same_admission(old, plan, p))
        {
            continue;
        }
        if old.is_none() && p.device == device {
            if p.key_package.is_some() || p.leaf != 0 {
                return Err(proof());
            }
            continue;
        }
        let reference = p.key_package.ok_or_else(proof)?;
        if !new_refs.insert(reference) {
            return Err(proof());
        }
    }
    for reference in new_refs {
        let encoded = B64.encode(&reference);
        let row:Option<AdmissionPackage>=sqlx::query_as("SELECT user_id,device_id,incarnation,wire,expires_at,spent FROM e2ee_key_packages WHERE reference=$1 FOR UPDATE")
            .bind(&encoded).fetch_optional(&mut *tx).await?;
        let Some(AdmissionPackage {
            user_id: user,
            device_id: target,
            incarnation,
            wire: Some(bytes),
            expires_at: expires,
            spent: false,
        }) = row
        else {
            return Err(Error::new(StatusCode::CONFLICT, "crypto_key_package_spent"));
        };
        let p = plan
            .participants
            .iter()
            .find(|p| p.key_package == Some(reference))
            .ok_or_else(proof)?;
        // Full validation was already performed at publication. Here we bind
        // the certified credential retained in that exact, immutable TLS blob.
        let certificate = verify(app, move || {
            let provider = OpenMlsRustCrypto::default();
            let package = KeyPackageIn::tls_deserialize_exact(&bytes)
                .map_err(|_| proof())?
                .validate(provider.crypto(), ProtocolVersion::Mls10)
                .map_err(|_| proof())?;
            Certificate::from_credential(package.leaf_node().credential()).map_err(|_| proof())
        })
        .await?;
        if user != p.user
            || target != p.device
            || incarnation != hex(&p.incarnation)
            || expires <= now
            || certificate.fingerprint().map_err(|_| proof())? != p.certificate
        {
            return Err(proof());
        }
        admission_deadline = admission_deadline.min(expires);
        if !plan
            .welcomes
            .iter()
            .any(|w| w.device == p.device && w.key_package == reference)
        {
            return Err(proof());
        }
        admitted.insert(p.device.as_str());
        sqlx::query("UPDATE e2ee_key_packages SET spent=true,wire=NULL,consumed_group=$2,consumed_operation=$3 WHERE reference=$1")
            .bind(&encoded).bind(&group).bind(&operation).execute(&mut *tx).await?;
    }
    if plan
        .welcomes
        .iter()
        .any(|w| !admitted.contains(w.device.as_str()))
    {
        return Err(proof());
    }
    auth::lock_active(&mut tx, actor).await?;
    let final_now: i64 =
        sqlx::query_scalar("SELECT floor(EXTRACT(EPOCH FROM clock_timestamp()))::bigint")
            .fetch_one(&mut *tx)
            .await?;
    roster(&mut tx, plan, &authority, final_now).await?;
    if final_now >= author.expires_at as i64 || final_now >= admission_deadline {
        return Err(proof());
    }
    let receipt = wire::GroupReceipt {
        scope,
        room_id: room.into(),
        incarnation: hex(&plan.scope.incarnation),
        operation_id: operation.clone(),
        revision: (plan.expected_revision + 1).to_string(),
        epoch: plan.epoch.to_string(),
        fingerprint: hex(&checked.transition.fingerprint().map_err(|_| proof())?),
    };
    sqlx::query("INSERT INTO e2ee_groups(room_id,data_epoch,incarnation,revision,epoch,fingerprint,transition,tree,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(room_id) DO UPDATE SET revision=EXCLUDED.revision,epoch=EXCLUDED.epoch,fingerprint=EXCLUDED.fingerprint,transition=EXCLUDED.transition,tree=EXCLUDED.tree,receipt=EXCLUDED.receipt")
        .bind(room).bind(&receipt.scope.data_epoch).bind(&receipt.incarnation).bind(plan.expected_revision as i64+1).bind(plan.epoch as i64)
        .bind(&receipt.fingerprint).bind(&checked.bytes).bind(&checked.tree).bind(Json(&receipt)).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO e2ee_group_events(room_id,revision,transition,commit,receipt) VALUES($1,$2,$3,$4,$5)")
        .bind(room).bind(plan.expected_revision as i64+1).bind(&checked.bytes).bind(&checked.commit).bind(Json(&receipt)).execute(&mut *tx).await?;
    for participant in &plan.participants {
        sqlx::query("INSERT INTO e2ee_group_recipients(room_id,revision,device_id,witness) VALUES($1,$2,$3,$4)")
            .bind(room).bind(plan.expected_revision as i64+1).bind(&participant.device).bind(Json(admission_witness(plan, participant)?)).execute(&mut *tx).await?;
    }
    let delivery_position = crate::store::next_position(&mut tx).await?;
    sqlx::query("INSERT INTO e2ee_delivery(position,room_id,group_revision) VALUES($1,$2,$3)")
        .bind(delivery_position)
        .bind(room)
        .bind(plan.expected_revision as i64 + 1)
        .execute(&mut *tx)
        .await?;
    for (welcome, payload) in checked.welcomes {
        let participant = plan
            .participants
            .iter()
            .find(|p| p.device == welcome.device_id)
            .ok_or_else(proof)?;
        let member = plan
            .members
            .iter()
            .find(|m| m.user == participant.user)
            .ok_or_else(proof)?;
        sqlx::query("INSERT INTO e2ee_group_welcomes(room_id,revision,device_id,incarnation,access_version,key_package_ref,payload) VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(room).bind(plan.expected_revision as i64+1).bind(welcome.device_id).bind(welcome.incarnation).bind(&member.access_version).bind(welcome.key_package_ref).bind(payload).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO e2ee_group_operations(user_id,device_id,operation_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)")
        .bind(&actor.id).bind(device).bind(operation).bind(fingerprint).bind(Json(&receipt)).execute(&mut *tx).await?;
    // A large fanout also takes time after the proof checks. Recheck immediately
    // before commit so expired admissions cannot become durable during inserts.
    auth::lock_active(&mut tx, actor).await?;
    let before_commit: i64 =
        sqlx::query_scalar("SELECT floor(EXTRACT(EPOCH FROM clock_timestamp()))::bigint")
            .fetch_one(&mut *tx)
            .await?;
    let roster_deadline = roster(&mut tx, plan, &authority, before_commit).await?;
    let commit_now: i64 =
        sqlx::query_scalar("SELECT floor(EXTRACT(EPOCH FROM clock_timestamp()))::bigint")
            .fetch_one(&mut *tx)
            .await?;
    if commit_now >= author.expires_at as i64 || commit_now >= admission_deadline {
        return Err(proof());
    }
    if commit_now >= roster_deadline {
        return Err(wait());
    }
    tx.commit().await?;
    Ok(receipt)
}

struct ReadAccess {
    tx: Transaction<'static, Postgres>,
    device: String,
    authority: String,
    scope: wire::Scope,
    now: i64,
    deadline: Instant,
}
fn monotonic_deadline(value: chrono::DateTime<Utc>) -> Result<Instant> {
    let remaining = (value - Utc::now())
        .to_std()
        .map_err(|_| Error::unauthorized())?;
    Instant::now()
        .checked_add(remaining)
        .ok_or_else(Error::internal)
}
async fn read_lock(app: &App, actor: &Account, room: &str) -> Result<ReadAccess> {
    let mut tx = app.pool.begin().await?;
    let (instance_id, data_epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton")
            .fetch_one(&mut *tx)
            .await?;
    let scope = wire::Scope {
        instance_id,
        data_epoch,
    };
    let (device, now) = lock_scope(&mut tx, actor, &scope).await?;
    let (_, authority) = room_lock(&mut tx, actor, room, false).await?;
    let session: chrono::DateTime<Utc> =
        sqlx::query_scalar("SELECT expires_at FROM sessions WHERE token_hash=$1")
            .bind(&actor.session_hash)
            .fetch_one(&mut *tx)
            .await?;
    let deadline = monotonic_deadline(session)?;
    Ok(ReadAccess {
        tx,
        device,
        authority,
        scope,
        now,
        deadline,
    })
}
async fn reader(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    device: &str,
    plan: &public::Plan,
    now: i64,
    session_deadline: Instant,
) -> Result<(String, Instant)> {
    let p = plan
        .participants
        .iter()
        .find(|p| p.device == device && p.user == actor.id)
        .ok_or_else(Error::forbidden)?;
    lock_fences(tx, std::iter::once(p.clone())).await?;
    let row: Option<(String, i64)> = sqlx::query_as(
        "SELECT incarnation,expires_at FROM e2ee_devices WHERE device_id=$1 AND user_id=$2",
    )
    .bind(device)
    .bind(&actor.id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((incarnation, expires)) = row else {
        return Err(revoked());
    };
    let access: String =
        sqlx::query_scalar("SELECT access_version FROM members WHERE room_id=$1 AND user_id=$2")
            .bind(&plan.scope.room)
            .bind(&actor.id)
            .fetch_one(&mut **tx)
            .await?;
    let activation: Option<&str> = plan
        .members
        .iter()
        .find(|m| m.user == actor.id && m.access_version == access)
        .map(|m| m.activation_version.as_str());
    if incarnation != hex(&p.incarnation)
        || expires <= now
        || activation != Some(actor.activation_version.as_str())
    {
        return Err(revoked());
    }
    let certificate_deadline = monotonic_deadline(
        chrono::DateTime::from_timestamp(expires, 0).ok_or_else(Error::internal)?,
    )?;
    Ok((access, session_deadline.min(certificate_deadline)))
}
fn response<T: Serialize>(
    value: &T,
    tx: Transaction<'static, Postgres>,
    deadline: Instant,
) -> Result<Response> {
    let bytes = serde_json::to_vec(value).map_err(|_| Error::internal())?;
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(Error::unauthorized)?;
    Ok(crate::delivery::leased_bytes_for(
        Bytes::from(bytes),
        tx,
        "application/json",
        remaining,
    ))
}
pub async fn observe_roster(app: &App, actor: &Account, room: &str) -> Result<Response> {
    let ReadAccess {
        mut tx,
        scope,
        authority,
        deadline,
        ..
    } = read_lock(app, actor, room).await?;
    let members = current_members(&mut tx, room).await?;
    if members.len() > public::MAX_MEMBERS {
        return Err(Error::new(StatusCode::CONFLICT, "crypto_group_limit"));
    }
    let group: Option<(String, Json<wire::GroupReceipt>)> =
        sqlx::query_as("SELECT data_epoch,receipt FROM e2ee_groups WHERE room_id=$1")
            .bind(room)
            .fetch_optional(&mut *tx)
            .await?;
    let group = match group {
        Some((epoch, receipt))
            if epoch == scope.data_epoch
                && receipt.scope.instance_id == scope.instance_id
                && receipt.scope.data_epoch == scope.data_epoch
                && receipt.room_id == room =>
        {
            Some(receipt.0)
        }
        Some(_) => return Err(stale()),
        None => None,
    };
    // Any current member can observe public routing grants, even before device
    // enrollment or admission. This grants neither MLS membership nor key trust.
    // Remote activation can change after this snapshot; submit rechecks it.
    response(
        &wire::GroupRoster {
            scope,
            room_id: room.into(),
            authority_version: authority,
            members: members
                .into_iter()
                .map(|m| wire::GroupMember {
                    user_id: m.user,
                    access_version: m.access_version,
                    activation_version: m.activation_version,
                })
                .collect(),
            group,
        },
        tx,
        deadline,
    )
}
pub async fn state(app: &App, actor: &Account, room: &str) -> Result<Response> {
    let ReadAccess {
        mut tx,
        device,
        authority,
        scope,
        now,
        deadline,
    } = read_lock(app, actor, room).await?;
    let head = head(&mut tx, room).await?.ok_or_else(Error::missing)?;
    if head.data_epoch != scope.data_epoch {
        return Err(stale());
    }
    let plan = Transition::from_bytes(&head.transition)
        .map_err(|_| Error::internal())?
        .plan;
    let (_, remaining) = reader(&mut tx, actor, &device, &plan, now, deadline).await?;
    let needs_rekey = match roster(&mut tx, &plan, &authority, now).await {
        Ok(_) => false,
        Err(error) if error.code == "crypto_rekey_required" => true,
        Err(error) => return Err(error),
    };
    response(
        &wire::GroupState {
            receipt: head.receipt.0,
            needs_rekey,
            transition: B64.encode(&head.transition),
            tree: B64.encode(&head.tree),
        },
        tx,
        remaining,
    )
}
pub async fn events(
    app: &App,
    actor: &Account,
    room: &str,
    after: Option<&str>,
) -> Result<Response> {
    let after = after.map(decimal).transpose()?.unwrap_or(0);
    let ReadAccess {
        mut tx,
        device,
        scope,
        now,
        deadline,
        ..
    } = read_lock(app, actor, room).await?;
    let head = head(&mut tx, room).await?.ok_or_else(Error::missing)?;
    if head.data_epoch != scope.data_epoch {
        return Err(stale());
    }
    let plan = Transition::from_bytes(&head.transition)
        .map_err(|_| Error::internal())?
        .plan;
    let (access, remaining) = reader(&mut tx, actor, &device, &plan, now, deadline).await?;
    type Row = (
        Vec<u8>,
        Option<Vec<u8>>,
        Json<wire::GroupReceipt>,
        Option<String>,
        Option<String>,
        Option<Vec<u8>>,
    );
    let rows:Vec<Row>=sqlx::query_as("SELECT e.transition,e.commit,e.receipt,w.incarnation,w.key_package_ref,w.payload FROM e2ee_group_events e LEFT JOIN e2ee_group_welcomes w ON w.room_id=e.room_id AND w.revision=e.revision AND w.device_id=$2 AND w.incarnation=$3 AND w.access_version=$4 WHERE e.room_id=$1 AND e.revision>$5 ORDER BY e.revision LIMIT 17")
        .bind(room).bind(&device).bind(hex(&plan.participants.iter().find(|p|p.device==device).ok_or_else(Error::forbidden)?.incarnation)).bind(access).bind(after).fetch_all(&mut *tx).await?;
    let mut events = Vec::new();
    let mut bytes = 0;
    for (transition, commit, receipt, incarnation, reference, payload) in rows {
        let size = transition.len()
            + commit.as_ref().map_or(0, Vec::len)
            + payload.as_ref().map_or(0, Vec::len);
        if !events.is_empty() && bytes + size > TOTAL || events.len() == 16 {
            break;
        }
        bytes += size;
        let welcome = match (incarnation, reference, payload) {
            (Some(incarnation), Some(key_package_ref), Some(payload)) => Some(wire::GroupWelcome {
                device_id: device.clone(),
                incarnation,
                key_package_ref,
                payload: B64.encode(&payload),
            }),
            _ => None,
        };
        events.push(wire::GroupEvent {
            receipt: receipt.0,
            transition: B64.encode(&transition),
            commit: commit.as_ref().map(|b| B64.encode(b)),
            welcome,
        });
    }
    let next = events
        .last()
        .filter(|e| {
            e.receipt
                .revision
                .parse::<i64>()
                .ok()
                .is_some_and(|r| r < head.revision)
        })
        .map(|e| e.receipt.revision.clone());
    response(&wire::GroupEventPage { events, next }, tx, remaining)
}

pub async fn available(
    app: &App,
    actor: &Account,
    room: &str,
    user: &str,
    device: &str,
) -> Result<Response> {
    if !auth::identifier(user) || !auth::identifier(device) {
        return Err(Error::invalid());
    }
    let ReadAccess {
        mut tx,
        scope,
        now,
        deadline,
        ..
    } = read_lock(app, actor, room).await?;
    crate::store::require_member(&mut tx, room, user).await?;
    let row:Option<(String,i64)>=sqlx::query_as("SELECT d.incarnation,d.expires_at FROM e2ee_devices d JOIN sessions s ON s.device_id=d.device_id WHERE d.user_id=$1 AND d.device_id=$2 AND s.expires_at>clock_timestamp() AND d.expires_at>$3")
        .bind(user).bind(device).bind(now).fetch_optional(&mut *tx).await?;
    let (incarnation, _) = row.ok_or_else(Error::missing)?;
    let row:Option<(String,Vec<u8>)>=sqlx::query_as("SELECT reference,wire FROM e2ee_key_packages WHERE user_id=$1 AND device_id=$2 AND incarnation=$3 AND NOT spent AND expires_at>$4 ORDER BY expires_at,reference LIMIT 1")
        .bind(user).bind(device).bind(&incarnation).bind(now).fetch_optional(&mut *tx).await?;
    let (reference, wire) = row.ok_or_else(Error::missing)?;
    // This is an observation; consumption occurs only with an accepted commit.
    response(
        &wire::AvailableKeyPackage {
            scope,
            user_id: user.into(),
            device_id: device.into(),
            incarnation,
            reference,
            wire: B64.encode(&wire),
        },
        tx,
        deadline,
    )
}

pub async fn operation(
    app: &App,
    actor: &Account,
    room: &str,
    operation: &str,
) -> Result<Response> {
    if !auth::identifier(room) || !auth::identifier(operation) {
        return Err(Error::invalid());
    }
    // Personal public ACK only. Room withdrawal and certificate retirement
    // cannot make an accepted own transition uncertain; no tree/Welcome here.
    let mut tx = app.pool.begin().await?;
    let (instance_id, data_epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton")
            .fetch_one(&mut *tx)
            .await?;
    let scope = wire::Scope {
        instance_id,
        data_epoch,
    };
    let (device, _) = lock_scope(&mut tx, actor, &scope).await?;
    let receipt:Option<Json<wire::GroupReceipt>>=sqlx::query_scalar("SELECT result FROM e2ee_group_operations WHERE user_id=$1 AND device_id=$2 AND operation_id=$3")
        .bind(&actor.id).bind(&device).bind(operation).fetch_optional(&mut *tx).await?;
    let Some(receipt) = receipt else {
        let value:Option<Json<wire::GroupCancellation>>=sqlx::query_scalar("SELECT receipt FROM e2ee_group_cancellations WHERE user_id=$1 AND device_id=$2 AND operation_id=$3")
            .bind(&actor.id).bind(&device).bind(operation).fetch_optional(&mut *tx).await?;
        if value.is_some_and(|v| {
            v.0.room_id == room
                && v.0.scope.instance_id == scope.instance_id
                && v.0.scope.data_epoch == scope.data_epoch
        }) {
            return Err(settlement::cancelled());
        }
        return Err(Error::missing());
    };
    let receipt = receipt.0;
    if receipt.room_id != room {
        return Err(Error::missing());
    }
    if receipt.scope.data_epoch != scope.data_epoch
        || receipt.scope.instance_id != scope.instance_id
    {
        return Err(stale());
    }
    let expires: chrono::DateTime<Utc> =
        sqlx::query_scalar("SELECT expires_at FROM sessions WHERE token_hash=$1")
            .bind(&actor.session_hash)
            .fetch_one(&mut *tx)
            .await?;
    response(&receipt, tx, monotonic_deadline(expires)?)
}

#[cfg(test)]
mod deadlines {
    use super::*;
    use std::time::Duration;
    #[sqlx::test]
    async fn serialization_does_not_extend_the_captured_read_deadline(pool: sqlx::PgPool) {
        struct Slow;
        impl Serialize for Slow {
            fn serialize<S: serde::Serializer>(
                &self,
                serializer: S,
            ) -> std::result::Result<S::Ok, S::Error> {
                std::thread::sleep(Duration::from_millis(10));
                serializer.serialize_str("payload whose authority expired during serialization")
            }
        }
        let tx = pool.begin().await.unwrap();
        let result = response(&Slow, tx, Instant::now() + Duration::from_millis(1));
        assert_eq!(result.err().unwrap().code, "session_rejected");
    }
}
