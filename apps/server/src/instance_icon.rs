//! The server's icon: set or removed by an administrator, read by anyone (it
//! is what the apps' server rail and the login screen show, like a favicon).
//! Stored as a square PNG of at most 256 pixels in the private volume; the
//! revision moves on every change and is announced by the discovery document.
use crate::{
    App,
    auth::Account,
    error::{Error, Result},
    operator,
};
use axum::{
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use rv_protocol::admin::InstanceIcon;
use std::io::Cursor;

/// The largest image accepted, before it is re-encoded.
pub const ICON_BYTES: usize = 2 * 1024 * 1024;
/// The side of the stored square.
const SIDE: u32 = 256;

async fn current(app: &App) -> Result<(Option<String>, i64)> {
    Ok(
        sqlx::query_as("SELECT icon_object_id,icon_revision FROM instance WHERE singleton")
            .fetch_one(&app.pool)
            .await?,
    )
}

/// The current revision, `None` without an icon.
pub(crate) async fn revision(app: &App) -> Result<Option<String>> {
    let (object, revision) = current(app).await?;
    Ok(object.map(|_| revision.to_string()))
}

/// The PNG, public; 404 without an icon. Clients bust their caches with
/// `?v=<icon_revision>`; a revalidation of the current revision answers 304
/// without reading the file.
pub(crate) async fn response(app: &App, if_none_match: Option<&str>) -> Result<Response> {
    let (object, revision) = current(app).await?;
    let object = object.ok_or_else(Error::missing)?;
    let etag = format!("\"{revision}\"");
    if if_none_match.is_some_and(|tags| tags.split(',').any(|t| t.trim() == etag)) {
        return Ok((StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response());
    }
    let store = app.objects.as_ref().ok_or_else(Error::missing)?;
    let bytes = store.read(&object, ICON_BYTES as u64).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png".to_owned()),
            (header::CACHE_CONTROL, "no-cache".to_owned()),
            (header::ETAG, etag),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
        ],
        bytes,
    )
        .into_response())
}

/// Center-crops to a square, scales down to `SIDE` and re-encodes as PNG:
/// metadata, appended payloads and input formats never reach the readers.
fn decode(mime: &str, bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.is_empty() || bytes.len() > ICON_BYTES {
        return Err(Error::new(StatusCode::PAYLOAD_TOO_LARGE, "icon_too_large"));
    }
    let format = match mime {
        "image/png" => image::ImageFormat::Png,
        "image/jpeg" => image::ImageFormat::Jpeg,
        _ => {
            return Err(Error::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "invalid_icon",
            ));
        }
    };
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| Error::new(StatusCode::BAD_REQUEST, "invalid_icon"))?;
    let side = decoded.width().min(decoded.height());
    if side == 0 {
        return Err(Error::new(StatusCode::BAD_REQUEST, "invalid_icon"));
    }
    let square = decoded.crop_imm(
        (decoded.width() - side) / 2,
        (decoded.height() - side) / 2,
        side,
        side,
    );
    let scaled = if side > SIDE {
        square.resize_exact(SIDE, SIDE, image::imageops::FilterType::Lanczos3)
    } else {
        square
    };
    let mut output = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(scaled.into_rgba8())
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|_| Error::internal())?;
    Ok(output.into_inner())
}

/// Sets (`upload`) or removes the icon. A replay of the same operation
/// answers the current state and applies nothing.
pub(crate) async fn change(
    app: &App,
    actor: &Account,
    operation: &str,
    upload: Option<(String, Vec<u8>)>,
) -> Result<InstanceIcon> {
    let fingerprint = crate::admin::fingerprint(serde_json::json!([
        "instance.icon",
        upload
            .as_ref()
            .map(|(mime, bytes)| (mime.clone(), crate::auth::hash_token_bytes(bytes)))
    ]));
    let store = app
        .objects
        .as_ref()
        .ok_or_else(|| Error::new(StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable"))?;
    // Decoded before any lock is held, on the bounded image pool.
    let encoded = match upload {
        None => None,
        Some((mime, bytes)) => {
            let permit = app
                .image_slots
                .clone()
                .try_acquire_owned()
                .map_err(|_| Error::throttled("icon_busy", 1))?;
            Some(
                tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    decode(&mime, &bytes)
                })
                .await
                .map_err(|_| Error::internal())??,
            )
        }
    };
    // Written before any lock too: an object left by a refusal or a replay
    // is old enough for the collector after an hour, never before.
    let object = match encoded {
        Some(bytes) => Some(store.put(bytes).await?),
        None => None,
    };
    let (mut tx, replay) = crate::admin::admit(app, actor, true, operation, &fingerprint).await?;
    if replay {
        tx.commit().await?;
        return state(app).await;
    }
    // NO KEY UPDATE: the lock the UPDATE takes anyway, which leaves the
    // logins' and deliveries' shared locks on the instance row free.
    let previous: Option<String> =
        sqlx::query_scalar("SELECT icon_object_id FROM instance WHERE singleton FOR NO KEY UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    let revision: i64 = sqlx::query_scalar(
        "UPDATE instance SET icon_object_id=$1,icon_revision=icon_revision+1 WHERE singleton RETURNING icon_revision",
    )
    .bind(&object)
    .fetch_one(&mut *tx)
    .await?;
    operator::record(
        &mut tx,
        "instance.icon",
        "instance",
        serde_json::json!({"present": object.is_some(), "revision": revision.to_string()}),
    )
    .await?;
    crate::admin::settle(tx, actor, operation, &fingerprint).await?;
    if let Some(previous) = previous.filter(|p| Some(p) != object.as_ref()) {
        let _ = store.remove(&previous).await;
    }
    Ok(InstanceIcon {
        revision: object.map(|_| revision.to_string()),
    })
}

pub(crate) async fn state(app: &App) -> Result<InstanceIcon> {
    Ok(InstanceIcon {
        revision: revision(app).await?,
    })
}
