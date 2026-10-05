//! Public E2EE directory. No private key, recovery code or MLS group state.
use crate::{
    App, auth,
    auth::Account,
    error::{Error, Result},
};
use axum::http::StatusCode;
use chrono::Utc;
use data_encoding::BASE64URL_NOPAD as B64;
use openmls::{
    prelude::{KeyPackageIn, OpenMlsProvider, ProtocolVersion, tls_codec::Deserialize as _},
    treesync::LeafNodeSource,
};
use openmls_rust_crypto::OpenMlsRustCrypto;
use rv_crypto_public::{
    Certificate, Revocation,
    enrollment::{Grant, Request},
};
use rv_protocol::e2ee::{self as wire, OperationReceipt, Scope};
use serde::Serialize;
use sqlx::{Postgres, Transaction};
use std::collections::BTreeSet;

const PACKAGE_BYTES: usize = 16 * 1024;
const PACKAGE_BATCH: usize = 8;
const LIVE_PACKAGES: i64 = 64;
const DAILY_OPERATIONS: i64 = 256;
pub mod groups;
pub use groups::messages;
mod revocations;
pub use revocations::revoke;
pub mod backups;
pub mod history;
pub mod history_backup;

fn changed() -> Error {
    Error::new(StatusCode::CONFLICT, "crypto_identity_changed")
}
fn revision() -> Error {
    Error::new(StatusCode::CONFLICT, "revision_conflict")
}
fn revoked() -> Error {
    Error::new(StatusCode::FORBIDDEN, "crypto_device_revoked")
}
fn proof() -> Error {
    Error::new(StatusCode::BAD_REQUEST, "crypto_proof_invalid")
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn decimal(value: &str) -> Result<i64> {
    let parsed: i64 = value.parse().map_err(|_| Error::invalid())?;
    if parsed < 0 || parsed.to_string() != value {
        return Err(Error::invalid());
    }
    Ok(parsed)
}
fn decode(value: &str, limit: usize) -> Result<Vec<u8>> {
    if value.len() > limit.div_ceil(3) * 4 {
        return Err(Error::invalid());
    }
    let bytes = B64.decode(value.as_bytes()).map_err(|_| Error::invalid())?;
    if bytes.len() > limit {
        return Err(Error::invalid());
    }
    Ok(bytes)
}
fn intent(kind: &str, input: &impl Serialize) -> Result<String> {
    Ok(auth::hash_token(
        &serde_json::to_string(&(kind, input)).map_err(|_| Error::invalid())?,
    ))
}
fn validate_scope(scope: &Scope, operation: &str) -> Result<()> {
    if !auth::identifier(&scope.instance_id)
        || !auth::identifier(&scope.data_epoch)
        || !auth::identifier(operation)
    {
        return Err(Error::invalid());
    }
    Ok(())
}
async fn lock_scope(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    scope: &Scope,
) -> Result<(String, i64)> {
    auth::lock_active(tx, actor).await?;
    let current: (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton FOR KEY SHARE")
            .fetch_one(&mut **tx)
            .await?;
    if current != (scope.instance_id.clone(), scope.data_epoch.clone()) {
        return Err(Error::new(StatusCode::CONFLICT, "data_epoch_changed"));
    }
    let device: String = sqlx::query_scalar(
        "SELECT device_id FROM sessions WHERE token_hash=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(&actor.session_hash)
    .bind(&actor.id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(Error::unauthorized)?;
    let found: Option<String> =
        sqlx::query_scalar("SELECT id FROM session_devices WHERE id=$1 AND user_id=$2 FOR SHARE")
            .bind(&device)
            .bind(&actor.id)
            .fetch_optional(&mut **tx)
            .await?;
    if found.is_none() {
        return Err(Error::unauthorized());
    }
    let now: i64 =
        sqlx::query_scalar("SELECT floor(EXTRACT(EPOCH FROM clock_timestamp()))::bigint")
            .fetch_one(&mut **tx)
            .await?;
    Ok((device, now))
}
async fn saved(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    device: &str,
    operation: &str,
    fingerprint: &str,
) -> Result<Option<OperationReceipt>> {
    let row: Option<(String, serde_json::Value)> = sqlx::query_as("SELECT fingerprint,result FROM e2ee_operations WHERE user_id=$1 AND device_id=$2 AND operation_id=$3")
        .bind(&actor.id).bind(device).bind(operation).fetch_optional(&mut **tx).await?;
    match row {
        Some((old, value)) if old == fingerprint => Ok(Some(
            serde_json::from_value(value).map_err(|_| Error::internal())?,
        )),
        Some(_) => Err(Error::conflict()),
        None => Ok(None),
    }
}
async fn preflight(
    app: &App,
    actor: &Account,
    scope: &Scope,
    operation: &str,
    fingerprint: &str,
) -> Result<Option<OperationReceipt>> {
    let mut tx = app.pool.begin().await?;
    let (device, _) = lock_scope(&mut tx, actor, scope).await?;
    let result = saved(&mut tx, actor, &device, operation, fingerprint).await?;
    tx.commit().await?;
    Ok(result)
}
async fn quota(tx: &mut Transaction<'_, Postgres>, actor: &Account, device: &str) -> Result<()> {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_operations WHERE user_id=$1 AND device_id=$2 AND created_at>clock_timestamp()-interval '1 day'")
        .bind(&actor.id).bind(device).fetch_one(&mut **tx).await?;
    if count >= DAILY_OPERATIONS {
        return Err(Error::throttled("crypto_operation_limit", 3600));
    }
    Ok(())
}
async fn remember(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Account,
    fingerprint: &str,
    receipt: &OperationReceipt,
) -> Result<()> {
    sqlx::query("INSERT INTO e2ee_operations(user_id,device_id,operation_id,fingerprint,result) VALUES($1,$2,$3,$4,$5)")
        .bind(&actor.id).bind(&receipt.device_id).bind(&receipt.operation_id).bind(fingerprint)
        .bind(serde_json::to_value(receipt).map_err(|_| Error::internal())?).execute(&mut **tx).await?;
    Ok(())
}
async fn verify<T: Send + 'static>(
    app: &App,
    action: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let permit = app
        .crypto_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::throttled("crypto_busy", 1))?;
    tokio::task::spawn_blocking(move || {
        let _held = permit;
        action()
    })
    .await
    .map_err(|_| Error::internal())?
}

struct Registration {
    request: Request,
    grant: Grant,
    previous: Option<Revocation>,
}
pub async fn register(
    app: &App,
    actor: &Account,
    input: wire::RegisterDevice,
) -> Result<OperationReceipt> {
    validate_scope(&input.scope, &input.operation_id)?;
    if let Some(value) = &input.expected_device_revision
        && decimal(value)? == 0
    {
        return Err(Error::invalid());
    }
    if input.expected_root_fingerprint.as_ref().is_some_and(|s| {
        s.len() != 64
            || !s
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) {
        return Err(Error::invalid());
    }
    let fingerprint = intent("register_device", &input)?;
    if let Some(receipt) =
        preflight(app, actor, &input.scope, &input.operation_id, &fingerprint).await?
    {
        return Ok(receipt);
    }
    let encoded_request = input.request.clone();
    let encoded_grant = input.grant.clone();
    let previous = input.revoke_previous.clone();
    let checked = verify(app, move || {
        let request = Request::from_bytes(&decode(&encoded_request, 4096)?).map_err(|_| proof())?;
        let grant = Grant::from_bytes(&decode(&encoded_grant, 8192)?).map_err(|_| proof())?;
        let now = u64::try_from(Utc::now().timestamp()).map_err(|_| Error::internal())?;
        request.verify(now).map_err(|_| proof())?;
        grant.verify(now).map_err(|_| proof())?;
        let certificate = &grant.certificate.device;
        let body = &request.body;
        if grant.request != request.fingerprint().map_err(|_| proof())?
            || certificate.root != body.root
            || certificate.device != body.device
            || certificate.incarnation != body.incarnation
            || certificate.signature_key != body.signature_key
            || certificate.issued_at < body.issued_at
        {
            return Err(proof());
        }
        let previous: Option<Revocation> = previous
            .map(|s| serde_json::from_slice(&decode(&s, 4096)?).map_err(|_| proof()))
            .transpose()?;
        if let Some(value) = &previous {
            value.verify().map_err(|_| proof())?;
        }
        Ok(Registration {
            request,
            grant,
            previous,
        })
    })
    .await?;
    let mut tx = app.pool.begin().await?;
    let (device, now) = lock_scope(&mut tx, actor, &input.scope).await?;
    if let Some(receipt) = saved(&mut tx, actor, &device, &input.operation_id, &fingerprint).await?
    {
        tx.commit().await?;
        return Ok(receipt);
    }
    quota(&mut tx, actor, &device).await?;
    let cert = &checked.grant.certificate.device;
    if cert.device != device
        || cert.root.user != actor.id
        || cert.root.instance != input.scope.instance_id
    {
        return Err(proof());
    }
    if now < checked.request.body.issued_at as i64
        || now >= checked.request.body.expires_at as i64
        || now < cert.issued_at as i64
        || now >= cert.expires_at as i64
    {
        return Err(proof());
    }
    let root_fingerprint = hex(&cert.root.fingerprint().map_err(|_| proof())?);
    let root: Option<(Vec<u8>, String)> =
        sqlx::query_as("SELECT root,fingerprint FROM e2ee_identities WHERE user_id=$1 FOR UPDATE")
            .bind(&actor.id)
            .fetch_optional(&mut *tx)
            .await?;
    let encoded_root = serde_json::to_vec(&cert.root).map_err(|_| proof())?;
    match root {
        Some((existing, pinned))
            if existing == encoded_root
                && input.expected_root_fingerprint.as_deref() == Some(pinned.as_str()) => {}
        Some(_) => return Err(changed()),
        None if input.expected_root_fingerprint.is_none() => {
            sqlx::query("INSERT INTO e2ee_identities(user_id,root,fingerprint) VALUES($1,$2,$3)")
                .bind(&actor.id)
                .bind(&encoded_root)
                .bind(&root_fingerprint)
                .execute(&mut *tx)
                .await?;
        }
        None => return Err(changed()),
    }
    let incarnation = hex(&cert.incarnation);
    let denied: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM e2ee_revocations WHERE user_id=$1 AND device_id=$2 AND incarnation=$3)")
        .bind(&actor.id).bind(&device).bind(&incarnation).fetch_one(&mut *tx).await?;
    if denied {
        return Err(revoked());
    }
    type Old = (String, Vec<u8>, i64, i64, i64);
    let old: Option<Old> = sqlx::query_as("SELECT incarnation,signature_key,issued_at,expires_at,revision FROM e2ee_devices WHERE device_id=$1 AND user_id=$2 FOR UPDATE")
        .bind(&device).bind(&actor.id).fetch_optional(&mut *tx).await?;
    let next;
    if let Some((old_incarnation, old_key, issued, expires, rev)) = old {
        if input.expected_device_revision.as_deref() != Some(rev.to_string().as_str()) {
            return Err(revision());
        }
        if old_incarnation == incarnation {
            if old_key.as_slice() != cert.signature_key || checked.previous.is_some() {
                return Err(changed());
            }
            if cert.issued_at < issued as u64 || cert.expires_at < expires as u64 {
                return Err(revision());
            }
        } else {
            let signed = checked.previous.as_ref().ok_or_else(changed)?;
            if signed.root != cert.root
                || signed.device != device
                || hex(&signed.incarnation) != old_incarnation
            {
                return Err(proof());
            }
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM e2ee_revocations WHERE user_id=$1")
                    .bind(&actor.id)
                    .fetch_one(&mut *tx)
                    .await?;
            if count >= 4096 {
                return Err(Error::throttled("crypto_revocation_limit", 3600));
            }
            sqlx::query("INSERT INTO e2ee_revocations(user_id,device_id,incarnation,signed) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,device_id,incarnation) DO NOTHING")
                .bind(&actor.id).bind(&device).bind(&old_incarnation).bind(serde_json::to_vec(signed).map_err(|_| proof())?).execute(&mut *tx).await?;
            sqlx::query("UPDATE e2ee_key_packages SET spent=true,wire=NULL WHERE device_id=$1 AND incarnation=$2")
                .bind(&device).bind(&old_incarnation).execute(&mut *tx).await?;
        }
        next = rev.checked_add(1).ok_or_else(revision)?;
    } else {
        if input.expected_device_revision.is_some() || checked.previous.is_some() {
            return Err(revision());
        }
        next = 1;
    }
    let others: i64 = sqlx::query_scalar("SELECT count(*) FROM e2ee_devices d JOIN sessions s ON s.device_id=d.device_id WHERE d.user_id=$1 AND d.device_id<>$2 AND s.expires_at>clock_timestamp() AND d.expires_at>$3")
        .bind(&actor.id).bind(&device).bind(now).fetch_one(&mut *tx).await?;
    if others >= 64 {
        return Err(Error::throttled("crypto_device_limit", 3600));
    }
    sqlx::query("INSERT INTO e2ee_devices(device_id,user_id,incarnation,signature_key,certificate,issued_at,expires_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(device_id) DO UPDATE SET incarnation=EXCLUDED.incarnation,signature_key=EXCLUDED.signature_key,certificate=EXCLUDED.certificate,issued_at=EXCLUDED.issued_at,expires_at=EXCLUDED.expires_at,revision=EXCLUDED.revision")
        .bind(&device).bind(&actor.id).bind(&incarnation).bind(cert.signature_key.as_slice())
        .bind(serde_json::to_vec(&checked.grant.certificate).map_err(|_| proof())?)
        .bind(cert.issued_at as i64).bind(cert.expires_at as i64).bind(next).execute(&mut *tx).await?;
    let receipt = OperationReceipt {
        scope: input.scope,
        operation_id: input.operation_id,
        kind: "register_device".into(),
        device_id: device,
        incarnation,
        device_revision: next.to_string(),
        root_fingerprint,
        key_package_refs: Vec::new(),
    };
    remember(&mut tx, actor, &fingerprint, &receipt).await?;
    tx.commit().await?;
    Ok(receipt)
}

struct Package {
    bytes: Vec<u8>,
    reference: String,
    digest: String,
    certificate: Certificate,
    expires: i64,
}
pub async fn publish(
    app: &App,
    actor: &Account,
    input: wire::PublishKeyPackages,
) -> Result<OperationReceipt> {
    validate_scope(&input.scope, &input.operation_id)?;
    let wanted = decimal(&input.device_revision)?;
    if wanted == 0 || input.packages.is_empty() || input.packages.len() > PACKAGE_BATCH {
        return Err(Error::invalid());
    }
    let fingerprint = intent("publish_key_packages", &input)?;
    if let Some(receipt) =
        preflight(app, actor, &input.scope, &input.operation_id, &fingerprint).await?
    {
        return Ok(receipt);
    }
    let encoded = input.packages.clone();
    let packages = verify(app, move || {
        let provider = OpenMlsRustCrypto::default();
        let now = u64::try_from(Utc::now().timestamp()).map_err(|_| Error::internal())?;
        let mut references = BTreeSet::new();
        let mut result = Vec::new();
        for encoded in encoded {
            let bytes = decode(&encoded, PACKAGE_BYTES)?;
            let package = KeyPackageIn::tls_deserialize_exact(&bytes)
                .map_err(|_| proof())?
                .validate(provider.crypto(), ProtocolVersion::Mls10)
                .map_err(|_| proof())?;
            let certificate = Certificate::from_credential(package.leaf_node().credential())
                .map_err(|_| proof())?;
            certificate.verify(now).map_err(|_| proof())?;
            if package.ciphersuite() as u16 != 1
                || package.leaf_node().signature_key().as_slice()
                    != certificate.device.signature_key
            {
                return Err(proof());
            }
            let LeafNodeSource::KeyPackage(lifetime) = package.leaf_node().leaf_node_source()
            else {
                return Err(proof());
            };
            let expires = std::cmp::min(lifetime.not_after(), certificate.device.expires_at);
            let reference = B64.encode(
                package
                    .hash_ref(provider.crypto())
                    .map_err(|_| proof())?
                    .as_slice(),
            );
            if !references.insert(reference.clone()) {
                return Err(Error::invalid());
            }
            let digest = auth::hash_token_bytes(&bytes);
            result.push(Package {
                bytes,
                reference,
                digest,
                certificate,
                expires: expires as i64,
            });
        }
        Ok(result)
    })
    .await?;
    let mut tx = app.pool.begin().await?;
    let (device, now) = lock_scope(&mut tx, actor, &input.scope).await?;
    if let Some(receipt) = saved(&mut tx, actor, &device, &input.operation_id, &fingerprint).await?
    {
        tx.commit().await?;
        return Ok(receipt);
    }
    quota(&mut tx, actor, &device).await?;
    let head: Option<(String,Vec<u8>,i64,i64,String)> = sqlx::query_as("SELECT d.incarnation,d.signature_key,d.revision,d.expires_at,i.fingerprint FROM e2ee_devices d JOIN e2ee_identities i ON i.user_id=d.user_id WHERE d.device_id=$1 AND d.user_id=$2 FOR UPDATE OF d")
        .bind(&device).bind(&actor.id).fetch_optional(&mut *tx).await?;
    let (incarnation, key, current, expires, root_fingerprint) = head.ok_or_else(revoked)?;
    if wanted != current {
        return Err(revision());
    }
    if expires <= now {
        return Err(revoked());
    }
    sqlx::query("UPDATE e2ee_key_packages SET spent=true,wire=NULL WHERE device_id=$1 AND NOT spent AND expires_at<=$2")
        .bind(&device).bind(now).execute(&mut *tx).await?;
    for package in &packages {
        let cert = &package.certificate.device;
        if cert.root.instance != input.scope.instance_id
            || cert.root.user != actor.id
            || cert.device != device
            || hex(&cert.incarnation) != incarnation
            || cert.signature_key.as_slice() != key
            || hex(&cert.root.fingerprint().map_err(|_| proof())?) != root_fingerprint
            || package.expires <= now
        {
            return Err(proof());
        }
        let denied: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM e2ee_revocations WHERE user_id=$1 AND device_id=$2 AND incarnation=$3)")
            .bind(&actor.id).bind(&device).bind(&incarnation).fetch_one(&mut *tx).await?;
        if denied {
            return Err(revoked());
        }
        let existing: Option<String> =
            sqlx::query_scalar("SELECT digest FROM e2ee_key_packages WHERE reference=$1")
                .bind(&package.reference)
                .fetch_optional(&mut *tx)
                .await?;
        if existing.is_some_and(|old| old != package.digest) {
            return Err(Error::conflict());
        }
        sqlx::query("INSERT INTO e2ee_key_packages(reference,digest,user_id,device_id,incarnation,wire,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(reference) DO NOTHING")
            .bind(&package.reference).bind(&package.digest).bind(&actor.id).bind(&device).bind(&incarnation).bind(&package.bytes).bind(package.expires).execute(&mut *tx).await?;
    }
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM e2ee_key_packages WHERE device_id=$1 AND NOT spent AND expires_at>$2",
    )
    .bind(&device)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;
    if live > LIVE_PACKAGES {
        return Err(Error::throttled("crypto_key_package_limit", 60));
    }
    let receipt = OperationReceipt {
        scope: input.scope,
        operation_id: input.operation_id,
        kind: "publish_key_packages".into(),
        device_id: device,
        incarnation,
        device_revision: current.to_string(),
        root_fingerprint,
        key_package_refs: packages.into_iter().map(|p| p.reference).collect(),
    };
    remember(&mut tx, actor, &fingerprint, &receipt).await?;
    tx.commit().await?;
    Ok(receipt)
}

pub async fn operation(app: &App, actor: &Account, operation: &str) -> Result<OperationReceipt> {
    if !auth::identifier(operation) {
        return Err(Error::invalid());
    }
    let result: Option<serde_json::Value> = sqlx::query_scalar("SELECT o.result FROM e2ee_operations o JOIN sessions s ON s.device_id=o.device_id AND s.user_id=o.user_id WHERE o.user_id=$1 AND o.operation_id=$2 AND s.token_hash=$3 AND s.expires_at>clock_timestamp()")
        .bind(&actor.id).bind(operation).bind(&actor.session_hash).fetch_optional(&app.pool).await?;
    let receipt: OperationReceipt = serde_json::from_value(result.ok_or_else(Error::missing)?)
        .map_err(|_| Error::internal())?;
    let current: (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton")
            .fetch_one(&app.pool)
            .await?;
    if current
        != (
            receipt.scope.instance_id.clone(),
            receipt.scope.data_epoch.clone(),
        )
    {
        return Err(Error::new(StatusCode::CONFLICT, "data_epoch_changed"));
    }
    Ok(receipt)
}
pub async fn directory(app: &App, user: &str, after: Option<&str>) -> Result<wire::Directory> {
    directory_inner(app, user, after, false).await
}
pub async fn own_directory(
    app: &App,
    actor: &Account,
    after: Option<&str>,
) -> Result<wire::Directory> {
    directory_inner(app, &actor.id, after, true).await
}
async fn directory_inner(
    app: &App,
    user: &str,
    after: Option<&str>,
    historical: bool,
) -> Result<wire::Directory> {
    if !auth::identifier(user) {
        return Err(Error::invalid());
    }
    let after = after.map(decimal).transpose()?.unwrap_or(0);
    let mut tx = app.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let visible: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND NOT disabled)")
            .bind(user)
            .fetch_one(&mut *tx)
            .await?;
    if !visible {
        return Err(Error::missing());
    }
    let (instance_id, data_epoch): (String, String) =
        sqlx::query_as("SELECT instance_id,data_epoch FROM instance WHERE singleton")
            .fetch_one(&mut *tx)
            .await?;
    let root: Option<(Vec<u8>, String, i64)> =
        sqlx::query_as("SELECT root,fingerprint,revision FROM e2ee_identities WHERE user_id=$1")
            .bind(user)
            .fetch_optional(&mut *tx)
            .await?;
    let identity = root.map(|(root, fingerprint, revision)| wire::Identity {
        user_id: user.into(),
        root: B64.encode(&root),
        fingerprint,
        revision: revision.to_string(),
    });
    type Row = (String, String, Vec<u8>, i64, i64);
    let rows: Vec<Row> = sqlx::query_as("SELECT d.device_id,d.incarnation,d.certificate,d.revision,d.expires_at FROM e2ee_devices d JOIN sessions s ON s.device_id=d.device_id WHERE d.user_id=$1 AND s.expires_at>clock_timestamp() AND ($2 OR d.expires_at>EXTRACT(EPOCH FROM clock_timestamp())) ORDER BY d.device_id LIMIT 65")
        .bind(user).bind(historical).fetch_all(&mut *tx).await?;
    if rows.len() > 64 {
        return Err(Error::new(StatusCode::CONFLICT, "crypto_directory_limit"));
    }
    let devices = rows
        .into_iter()
        .map(
            |(device_id, incarnation, certificate, revision, expires_at)| wire::Device {
                device_id,
                incarnation,
                certificate: B64.encode(&certificate),
                revision: revision.to_string(),
                expires_at: expires_at.to_string(),
            },
        )
        .collect();
    let mut revoked: Vec<(i64,Vec<u8>)> = sqlx::query_as("SELECT position,signed FROM e2ee_revocations WHERE user_id=$1 AND position>$2 ORDER BY position LIMIT 129")
        .bind(user).bind(after).fetch_all(&mut *tx).await?;
    let has_more = revoked.len() > 128;
    revoked.truncate(128);
    let next_revocation = if has_more {
        revoked.last().map(|r| r.0.to_string())
    } else {
        None
    };
    let revocations = revoked
        .into_iter()
        .map(|(position, signed)| wire::Revocation {
            position: position.to_string(),
            signed: B64.encode(&signed),
        })
        .collect();
    tx.commit().await?;
    Ok(wire::Directory {
        scope: Scope {
            instance_id,
            data_epoch,
        },
        identity,
        devices,
        revocations,
        next_revocation,
    })
}

#[cfg(test)]
mod tests;
