//! A root-signed withdrawal is durable independently of the HTTP device family.
//! Original operation receipts belong to the sending controller, never the target.
use super::*;

pub async fn revoke(
    app: &App,
    actor: &Account,
    input: wire::RevokeDevice,
) -> Result<OperationReceipt> {
    validate_scope(&input.scope, &input.operation_id)?;
    if decimal(&input.device_revision)? == 0
        || input.incarnation.len() != 32
        || !input
            .incarnation
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::invalid());
    }
    let fingerprint = intent("revoke_device", &input)?;
    if let Some(receipt) =
        preflight(app, actor, &input.scope, &input.operation_id, &fingerprint).await?
    {
        return Ok(receipt);
    }
    let encoded = input.signed.clone();
    let signed: Revocation = verify(app, move || {
        let signed: Revocation =
            serde_json::from_slice(&decode(&encoded, 4096)?).map_err(|_| proof())?;
        signed.verify().map_err(|_| proof())?;
        Ok(signed)
    })
    .await?;
    let mut tx = app.pool.begin().await?;
    let (device, _) = lock_scope(&mut tx, actor, &input.scope).await?;
    if let Some(receipt) = saved(&mut tx, actor, &device, &input.operation_id, &fingerprint).await?
    {
        tx.commit().await?;
        return Ok(receipt);
    }
    crate::factors::recent(&mut tx, actor).await?;
    quota(&mut tx, actor, &device).await?;
    let root: Option<(Vec<u8>, String)> =
        sqlx::query_as("SELECT root,fingerprint FROM e2ee_identities WHERE user_id=$1 FOR UPDATE")
            .bind(&actor.id)
            .fetch_optional(&mut *tx)
            .await?;
    let (registered_root, root_fingerprint) = root.ok_or_else(changed)?;
    if signed.root.user != actor.id
        || signed.root.instance != input.scope.instance_id
        || registered_root != serde_json::to_vec(&signed.root).map_err(|_| proof())?
        || root_fingerprint != hex(&signed.root.fingerprint().map_err(|_| proof())?)
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
    let (incarnation, device_revision) = sender.ok_or_else(revoked)?;
    if incarnation != input.incarnation || device_revision.to_string() != input.device_revision {
        return Err(revision());
    }
    let withdrawn: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM e2ee_revocations WHERE user_id=$1 AND device_id=$2 AND incarnation=$3)",
    ).bind(&actor.id).bind(&device).bind(&incarnation).fetch_one(&mut *tx).await?;
    if withdrawn {
        return Err(revoked());
    }
    let target_incarnation = hex(&signed.incarnation);
    // Revoke another leaf (or a historical incarnation), keeping the controller
    // authenticated so that the exact receipt remains recoverable after a lost ACK.
    if signed.device == device && target_incarnation == incarnation {
        return Err(Error::invalid());
    }
    let existing: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM e2ee_revocations WHERE user_id=$1 AND device_id=$2 AND incarnation=$3)",
    ).bind(&actor.id).bind(&signed.device).bind(&target_incarnation).fetch_one(&mut *tx).await?;
    if !existing {
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM e2ee_revocations WHERE user_id=$1")
                .bind(&actor.id)
                .fetch_one(&mut *tx)
                .await?;
        if count >= 4096 {
            return Err(Error::throttled("crypto_revocation_limit", 3600));
        }
        sqlx::query("INSERT INTO e2ee_revocations(user_id,device_id,incarnation,signed) VALUES($1,$2,$3,$4)")
            .bind(&actor.id).bind(&signed.device).bind(&target_incarnation)
            .bind(serde_json::to_vec(&signed).map_err(|_| proof())?).execute(&mut *tx).await?;
    }
    // An old incarnation cannot kill a subsequently installed HTTP device.
    // A deleted/expired family may still receive its permanent signed withdrawal.
    sqlx::query("DELETE FROM session_devices WHERE id=$1 AND user_id=$2 AND EXISTS(SELECT 1 FROM e2ee_devices WHERE device_id=$1 AND user_id=$2 AND incarnation=$3)")
        .bind(&signed.device).bind(&actor.id).bind(&target_incarnation).execute(&mut *tx).await?;
    sqlx::query("UPDATE e2ee_key_packages SET spent=true,wire=NULL WHERE user_id=$1 AND device_id=$2 AND incarnation=$3 AND NOT spent")
        .bind(&actor.id).bind(&signed.device).bind(&target_incarnation).execute(&mut *tx).await?;
    let receipt = OperationReceipt {
        scope: input.scope,
        operation_id: input.operation_id,
        kind: "revoke_device".into(),
        device_id: device,
        incarnation,
        device_revision: device_revision.to_string(),
        root_fingerprint,
        key_package_refs: vec![],
    };
    remember(&mut tx, actor, &fingerprint, &receipt).await?;
    tx.commit().await?;
    Ok(receipt)
}
