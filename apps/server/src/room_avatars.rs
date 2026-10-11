//! Channel images are authenticated room metadata, retained by the object collector.
use crate::{
    App, auth,
    delivery::{ReadProof, leased_bytes},
    error::{Error, Result},
    room_details,
};
use axum::{
    body::Bytes,
    http::{StatusCode, header},
    response::Response,
};
use rv_protocol::{
    parity::{RoomCommandReceipt, RoomRole},
    profiles::AvatarCommand,
};
use sha2::{Digest, Sha256};

pub(crate) async fn set(
    app: &App,
    actor: &auth::Account,
    room: &str,
    input: AvatarCommand,
    mime: String,
    bytes: Bytes,
) -> Result<RoomCommandReceipt> {
    if app.objects.is_none() {
        return Err(Error::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "storage_unavailable",
        ));
    }
    if !auth::identifier(room)
        || !auth::identifier(&input.operation_id)
        || !auth::identifier(&input.expected_revision)
    {
        return Err(Error::invalid());
    }
    // Replay may succeed after demotion; apply checks its exact content fingerprint.
    if room_details::receipt(app, actor, room, &input.operation_id)
        .await
        .is_err()
    {
        let details = room_details::read(app, actor, room).await?;
        if details.permissions.role != RoomRole::Owner
            || details.room.kind == rv_protocol::RoomKind::Direct
        {
            return Err(Error::forbidden());
        }
        if details.revision != input.expected_revision {
            return Err(Error::new(StatusCode::CONFLICT, "revision_conflict"));
        }
    }
    let mut tx = app.pool.begin().await?;
    auth::lock_active(&mut tx, actor).await?;
    room_details::admission(&mut tx, &actor.id).await?;
    tx.commit().await?;
    let content_hash = format!("{:x}", Sha256::digest(&bytes));
    let permit = app
        .image_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::throttled("avatar_busy", 1))?;
    let content_type = mime.clone();
    let png = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        crate::profiles::decode_avatar(&content_type, &bytes)
    })
    .await
    .map_err(|_| Error::internal())??;
    room_details::apply(
        app,
        actor,
        room,
        room_details::Command::Avatar {
            input,
            mime,
            content_hash,
            png,
        },
    )
    .await
}

pub(crate) async fn image(
    app: &App,
    hash: &str,
    proof: &ReadProof,
    room: &str,
    revision: &str,
) -> Result<Response> {
    let objects = app.objects.as_ref().ok_or_else(Error::missing)?;
    let id: Option<String> = sqlx::query_scalar(
        "SELECT avatar_object_id FROM rooms WHERE id=$1 AND revision::text=$2 AND kind<>'direct'",
    )
    .bind(room)
    .bind(revision)
    .fetch_optional(&app.pool)
    .await?
    .flatten();
    let id = id.ok_or_else(Error::missing)?;
    let bytes = objects
        .read(&id, crate::profiles::AVATAR_BYTES as u64)
        .await?;
    let mut lease = proof.lock(app, hash, &[room.to_owned()], None).await?;
    let current: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM rooms WHERE id=$1 AND revision::text=$2 AND avatar_object_id=$3)")
        .bind(room).bind(revision).bind(&id).fetch_one(&mut *lease).await?;
    if !current {
        return Err(Error::missing());
    }
    let mut response = leased_bytes(bytes.into(), lease, "image/png");
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    Ok(response)
}
