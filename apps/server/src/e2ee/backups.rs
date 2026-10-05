//! Root-authenticated encrypted backup. Receipts survive a replaced active packet.
use super::*;
use rv_crypto_public::recovery::{PUBLICATION_LIMIT, Publication};
async fn saved_backup(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    device: &str,
    operation: &str,
    fingerprint: Option<&str>,
) -> Result<Option<wire::RootBackupReceipt>> {
    let row: Option<(String, serde_json::Value)> = sqlx::query_as("SELECT fingerprint,receipt FROM e2ee_root_backup_operations WHERE user_id=$1 AND device_id=$2 AND operation_id=$3")
        .bind(&actor.id).bind(device).bind(operation).fetch_optional(&mut **tx).await?;
    match row {
        Some((old, value)) if fingerprint.is_none_or(|fp| fp == old) => Ok(Some(
            serde_json::from_value(value).map_err(|_| Error::invalid())?,
        )),
        Some(_) => Err(Error::new(StatusCode::CONFLICT, "operation_conflict")),
        None => Ok(None),
    }
}
pub async fn operation(
    app: &App,
    actor: &Account,
    operation: &str,
) -> Result<wire::RootBackupReceipt> {
    if !auth::identifier(operation) {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    let current: (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton FOR KEY SHARE")
            .fetch_one(&mut *tx)
            .await?;
    let scope = Scope {
        instance_id: current.0,
        data_epoch: current.1,
    };
    let (device, _) = lock_scope(&mut tx, actor, &scope).await?;
    let receipt = saved_backup(&mut tx, actor, &device, operation, None)
        .await?
        .ok_or_else(Error::missing)?;
    if receipt.scope.instance_id != scope.instance_id
        || receipt.scope.data_epoch != scope.data_epoch
    {
        return Err(Error::new(StatusCode::CONFLICT, "data_epoch_changed"));
    }
    tx.commit().await?;
    Ok(receipt)
}
pub async fn current(app: &App, actor: &Account) -> Result<wire::RootBackupState> {
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    let scope: (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton FOR KEY SHARE")
            .fetch_one(&mut *tx)
            .await?;
    let row: Option<(Vec<u8>, serde_json::Value)> =
        sqlx::query_as("SELECT publication,receipt FROM e2ee_root_backups WHERE user_id=$1")
            .bind(&actor.id)
            .fetch_optional(&mut *tx)
            .await?;
    let active = row
        .map(|(publication, receipt)| -> Result<_> {
            Ok(wire::RootBackupVersion {
                publication: B64.encode(&publication),
                receipt: serde_json::from_value(receipt).map_err(|_| Error::invalid())?,
            })
        })
        .transpose()?;
    tx.commit().await?;
    Ok(wire::RootBackupState {
        scope: Scope {
            instance_id: scope.0,
            data_epoch: scope.1,
        },
        active,
    })
}
pub async fn publish(
    app: &App,
    actor: &Account,
    input: wire::PublishRootBackup,
) -> Result<wire::RootBackupReceipt> {
    validate_scope(&input.scope, &input.operation_id)?;
    let fingerprint = intent("root_backup", &input)?;
    // The original result can be recovered without a fresh auth ceremony.
    let mut initial = app.pool.begin().await?;
    let (device, _) = lock_scope(&mut initial, actor, &input.scope).await?;
    if let Some(receipt) = saved_backup(
        &mut initial,
        actor,
        &device,
        &input.operation_id,
        Some(&fingerprint),
    )
    .await?
    {
        initial.commit().await?;
        return Ok(receipt);
    }
    initial.commit().await?;
    let encoded = input.publication.clone();
    let publication = verify(app, move || {
        Publication::from_bytes(&decode(&encoded, PUBLICATION_LIMIT)?).map_err(|_| proof())
    })
    .await?;
    let body = &publication.body;
    if body.scope.instance != input.scope.instance_id
        || body.scope.data_epoch != input.scope.data_epoch
        || body.operation != input.operation_id
    {
        return Err(proof());
    }
    let mut tx = app.pool.begin().await?;
    let (device, _) = lock_scope(&mut tx, actor, &input.scope).await?;
    if let Some(receipt) = saved_backup(
        &mut tx,
        actor,
        &device,
        &input.operation_id,
        Some(&fingerprint),
    )
    .await?
    {
        tx.commit().await?;
        return Ok(receipt);
    }
    let root: Option<(Vec<u8>, String)> =
        sqlx::query_as("SELECT root,fingerprint FROM e2ee_identities WHERE user_id=$1 FOR UPDATE")
            .bind(&actor.id)
            .fetch_optional(&mut *tx)
            .await?;
    let (root, root_fingerprint) = root.ok_or_else(changed)?;
    // Serialize the CAS, quota and duplicate intents for the whole root.
    if let Some(receipt) = saved_backup(
        &mut tx,
        actor,
        &device,
        &input.operation_id,
        Some(&fingerprint),
    )
    .await?
    {
        tx.commit().await?;
        return Ok(receipt);
    }
    crate::factors::recent(&mut tx, actor).await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_root_backup_operations WHERE user_id=$1 AND device_id=$2 AND created_at>clock_timestamp()-interval '1 day'").bind(&actor.id).bind(&device).fetch_one(&mut *tx).await?;
    if count >= 64 {
        return Err(Error::throttled("crypto_backup_limit", 3600));
    }
    if publication.packet.header.root.user != actor.id
        || root != serde_json::to_vec(&publication.packet.header.root).map_err(|_| proof())?
        || root_fingerprint
            != hex(&publication
                .packet
                .header
                .root
                .fingerprint()
                .map_err(|_| proof())?)
    {
        return Err(changed());
    }
    let sender: Option<(String, i64)> = sqlx::query_as(
        "SELECT incarnation,revision FROM e2ee_devices WHERE device_id=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(&device)
    .bind(&actor.id)
    .fetch_optional(&mut *tx)
    .await?;
    let (incarnation, sender_revision) = sender.ok_or_else(revoked)?;
    if device != body.device
        || incarnation != hex(&body.incarnation)
        || sender_revision.to_string() != body.device_revision
    {
        return Err(revision());
    }
    let withdrawn: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM e2ee_revocations WHERE user_id=$1 AND device_id=$2 AND incarnation=$3)").bind(&actor.id).bind(&device).bind(&incarnation).fetch_one(&mut *tx).await?;
    if withdrawn {
        return Err(revoked());
    }
    let previous: Option<i64> =
        sqlx::query_scalar("SELECT revision FROM e2ee_root_backups WHERE user_id=$1 FOR UPDATE")
            .bind(&actor.id)
            .fetch_optional(&mut *tx)
            .await?;
    if previous.map(|r| r.to_string()) != body.expected_revision {
        return Err(Error::new(StatusCode::CONFLICT, "backup_revision_conflict"));
    }
    let next = previous.unwrap_or(0).checked_add(1).ok_or_else(revision)?;
    let receipt = wire::RootBackupReceipt {
        scope: input.scope,
        operation_id: input.operation_id,
        device_id: device,
        incarnation,
        device_revision: sender_revision.to_string(),
        root_fingerprint,
        backup_id: hex(&publication.packet.header.backup_id),
        backup_revision: next.to_string(),
        packet_digest: hex(&body.packet_digest),
    };
    let value = serde_json::to_value(&receipt).map_err(|_| proof())?;
    sqlx::query("INSERT INTO e2ee_root_backups(user_id,revision,publication,receipt) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET revision=EXCLUDED.revision,publication=EXCLUDED.publication,receipt=EXCLUDED.receipt")
        .bind(&actor.id).bind(next).bind(publication.to_bytes().map_err(|_| proof())?).bind(&value).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO e2ee_root_backup_operations(user_id,device_id,operation_id,fingerprint,receipt) VALUES($1,$2,$3,$4,$5)")
        .bind(&actor.id).bind(&receipt.device_id).bind(&receipt.operation_id).bind(fingerprint).bind(value).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(receipt)
}
