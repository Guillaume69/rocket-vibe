//! Administrator invitation management; only hashes and metadata are persisted.
use crate::{
    App,
    auth::{self, Account},
    error::{Error, Result},
    invitations::Invitation,
    operator,
};
use rv_protocol::admin::{
    AccountInvitation, AdminOperation, CreateAccountInvitation, IssuedAccountInvitation,
};

pub(crate) fn wire(row: Invitation) -> AccountInvitation {
    AccountInvitation {
        id: row.id,
        created_at: row.created_at.to_rfc3339(),
        expires_at: row.expires_at.to_rfc3339(),
        consumed_at: row.consumed_at.map(|t| t.to_rfc3339()),
        revoked_at: row.revoked_at.map(|t| t.to_rfc3339()),
    }
}
pub(crate) async fn create(
    app: &App,
    actor: &Account,
    input: CreateAccountInvitation,
) -> Result<IssuedAccountInvitation> {
    if !(1..=168).contains(&input.hours)
        || input.token.len() != 64
        || !input
            .token
            .bytes()
            .all(|b| b.is_ascii_digit() || b"abcdef".contains(&b))
    {
        return Err(Error::invalid());
    }
    let digest = auth::hash_token(&input.token);
    let fingerprint = crate::admin::fingerprint(serde_json::json!([
        "invitation.create",
        input.hours,
        digest
    ]));
    let (mut tx, replay) =
        crate::admin::admit(app, actor, true, &input.operation_id, &fingerprint).await?;
    if replay {
        let row: Invitation = sqlx::query_as("SELECT id,created_at,expires_at,consumed_at,revoked_at FROM account_invitations WHERE issued_by=$1 AND operation_id=$2")
            .bind(&actor.id).bind(&input.operation_id).fetch_optional(&mut *tx).await?.ok_or_else(Error::missing)?;
        tx.commit().await?;
        return Ok(IssuedAccountInvitation {
            invitation: wire(row),
            token: input.token,
        });
    }
    // Same lock and quota as CLI issuance, fencing a data generation change.
    let epoch: String =
        sqlx::query_scalar("SELECT data_epoch FROM instance WHERE singleton FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM account_invitations WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() AND data_epoch=$1")
        .bind(&epoch).fetch_one(&mut *tx).await?;
    if count >= 1000 {
        return Err(Error::throttled("invitation_limit", 60));
    }
    let row: Invitation = sqlx::query_as("INSERT INTO account_invitations(id,token_hash,data_epoch,expires_at,issued_by,operation_id) VALUES($1,$2,$3,now()+make_interval(hours => $4),$5,$6) RETURNING id,created_at,expires_at,consumed_at,revoked_at")
        .bind(auth::random_token()[..24].to_owned()).bind(digest).bind(epoch).bind(input.hours as i32).bind(&actor.id).bind(&input.operation_id).fetch_one(&mut *tx).await?;
    operator::record(
        &mut tx,
        "invitation.issued",
        &row.id,
        serde_json::json!({"expires_at":row.expires_at}),
    )
    .await?;
    crate::admin::settle(tx, actor, &input.operation_id, &fingerprint).await?;
    Ok(IssuedAccountInvitation {
        invitation: wire(row),
        token: input.token,
    })
}
pub(crate) async fn revoke(
    app: &App,
    actor: &Account,
    id: &str,
    input: AdminOperation,
) -> Result<()> {
    if !auth::identifier(id) {
        return Err(Error::invalid());
    }
    let fingerprint = crate::admin::fingerprint(serde_json::json!(["invitation.revoke", id]));
    let (mut tx, replay) =
        crate::admin::admit(app, actor, true, &input.operation_id, &fingerprint).await?;
    if replay {
        tx.commit().await?;
        return Ok(());
    }
    let found: Option<String> = sqlx::query_scalar("UPDATE account_invitations SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 RETURNING id")
        .bind(id).fetch_optional(&mut *tx).await?;
    if found.is_none() {
        return Err(Error::missing());
    }
    operator::record(&mut tx, "invitation.revoked", id, serde_json::json!({})).await?;
    crate::admin::settle(tx, actor, &input.operation_id, &fingerprint).await
}
