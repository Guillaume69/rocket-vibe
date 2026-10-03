//! Operator-owned catalogue, atomic receipts and authenticated immutable images.
use crate::{
    App, auth,
    delivery::ReadProof,
    error::{Error, Result},
    operator,
};
use axum::{
    http::{StatusCode, header},
    response::Response,
};
use image::{AnimationDecoder, ImageDecoder};
use rv_protocol::custom_emojis::{CustomEmoji, EmojiCatalog};
use sqlx::{Postgres, Transaction, types::Json};
use std::io::Cursor;
pub const MAX_BYTES: usize = 1024 * 1024;

#[derive(sqlx::FromRow)]
struct CatalogRow {
    id: String,
    name: String,
    aliases: Json<Vec<String>>,
    object_id: String,
    sha256: String,
    media_type: String,
    bytes: i32,
    revision: i64,
}

impl CatalogRow {
    fn wire(self) -> CustomEmoji {
        CustomEmoji {
            id: self.id,
            name: self.name,
            aliases: self.aliases.0,
            file_id: self.object_id,
            sha256: self.sha256,
            media_type: self.media_type,
            bytes: self.bytes.to_string(),
            revision: self.revision.to_string(),
        }
    }
}

pub async fn catalog(app: &App) -> Result<EmojiCatalog> {
    let mut tx = app.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM emoji_catalog WHERE singleton")
        .fetch_one(&mut *tx)
        .await?;
    let rows = sqlx::query_as::<_, CatalogRow>(
        "SELECT id,name,aliases,object_id,sha256,media_type,bytes,revision FROM custom_emojis ORDER BY name LIMIT 513",
    )
    .fetch_all(&mut *tx)
    .await?;
    let catalog = EmojiCatalog {
        revision: revision.to_string(),
        items: rows.into_iter().map(CatalogRow::wire).collect(),
    };
    if !rv_protocol::custom_emojis::validate(&catalog) {
        return Err(Error::internal());
    }
    tx.commit().await?;
    Ok(catalog)
}
pub(crate) async fn catalog_response(app: &App, hash: &str, proof: &ReadProof) -> Result<Response> {
    let value = catalog(app).await?;
    let mut lease = proof.lock(app, hash, &[], None).await?;
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM emoji_catalog WHERE singleton FOR SHARE")
            .fetch_one(&mut *lease)
            .await?;
    if revision.to_string() != value.revision {
        return Err(Error::new(StatusCode::CONFLICT, "delivery_revalidate"));
    }
    Ok(crate::delivery::leased_bytes(
        serde_json::to_vec(&value)
            .map_err(|_| Error::internal())?
            .into(),
        lease,
        "application/json",
    ))
}
pub(crate) async fn image_response(
    app: &App,
    hash: &str,
    proof: &ReadProof,
    id: &str,
) -> Result<Response> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || b"abcdef".contains(&b))
    {
        return Err(Error::missing());
    }
    let objects = app.objects.as_ref().ok_or_else(Error::missing)?;
    let bytes = objects.read(id, MAX_BYTES as u64).await?;
    let mut lease = proof.lock(app, hash, &[], None).await?;
    let current:Option<(String,i32,String)>=sqlx::query_as("SELECT media_type,bytes,sha256 FROM custom_emojis WHERE object_id=$1 ORDER BY id LIMIT 1 FOR SHARE").bind(id).fetch_optional(&mut *lease).await?;
    let (mime, size, digest) = current.ok_or_else(Error::missing)?;
    let mime = match mime.as_str() {
        "image/png" => "image/png",
        "image/gif" => "image/gif",
        _ => return Err(Error::internal()),
    };
    if bytes.len() != size as usize || auth::hash_token_bytes(&bytes) != digest {
        return Err(Error::internal());
    }
    let mut response = crate::delivery::leased_bytes(bytes.into(), lease, mime);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    Ok(response)
}

fn decode(bytes: Vec<u8>) -> Result<(Vec<u8>, String)> {
    let invalid = || Error::new(StatusCode::BAD_REQUEST, "invalid_emoji_image");
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(Error::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "emoji_image_too_large",
        ));
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        let mut decoder =
            image::codecs::gif::GifDecoder::new(Cursor::new(&bytes)).map_err(|_| invalid())?;
        let (w, h) = decoder.dimensions();
        if w == 0 || h == 0 || w > 256 || h > 256 {
            return Err(invalid());
        }
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(256);
        limits.max_image_height = Some(256);
        limits.max_alloc = Some(4 * 1024 * 1024);
        decoder.set_limits(limits).map_err(|_| invalid())?;
        let mut pixels = 0u64;
        let mut frames = 0usize;
        for frame in decoder.into_frames() {
            let frame = frame.map_err(|_| invalid())?;
            frames += 1;
            pixels += u64::from(frame.buffer().width()) * u64::from(frame.buffer().height());
            if frames > 128 || pixels > 4 * 1024 * 1024 {
                return Err(invalid());
            }
        }
        if frames == 0 {
            return Err(invalid());
        }
        return Ok((bytes, "image/gif".into()));
    }
    let mut reader = image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| invalid())?;
    if !matches!(
        reader.format(),
        Some(image::ImageFormat::Png | image::ImageFormat::Jpeg)
    ) {
        return Err(invalid());
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(256);
    limits.max_image_height = Some(256);
    limits.max_alloc = Some(4 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| invalid())?;
    if decoded.width() == 0 || decoded.height() == 0 {
        return Err(invalid());
    }
    let mut output = Cursor::new(Vec::new());
    decoded
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|_| invalid())?;
    let output = output.into_inner();
    if output.len() > MAX_BYTES {
        return Err(invalid());
    }
    Ok((output, "image/png".into()))
}
async fn begin(
    app: &App,
    operation: &str,
    fingerprint: &str,
) -> Result<(
    Transaction<'static, Postgres>,
    String,
    Option<operator::Receipt>,
)> {
    if !auth::identifier(operation) {
        return Err(Error::invalid());
    }
    let mut tx = app.pool.begin().await?;
    auth::mutation_deadlines(&mut tx).await?;
    let epoch: String =
        sqlx::query_scalar("SELECT data_epoch FROM instance WHERE singleton FOR KEY SHARE")
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("rv-operator:{operation}"))
        .execute(&mut *tx)
        .await?;
    let old: Option<(String, String, Json<operator::Receipt>)> = sqlx::query_as(
        "SELECT data_epoch,command_hash,receipt FROM operator_commands WHERE operation_id=$1",
    )
    .bind(operation)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((old_epoch, old_hash, receipt)) = old {
        if old_epoch != epoch || old_hash != fingerprint {
            return Err(Error::conflict());
        }
        return Ok((tx, epoch, Some(receipt.0)));
    }
    sqlx::query("SELECT set_config('rocketvibe.operator_operation',$1,true)")
        .bind(operation)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT singleton FROM emoji_catalog WHERE singleton FOR UPDATE")
        .execute(&mut *tx)
        .await?;
    Ok((tx, epoch, None))
}
async fn finish(
    mut tx: Transaction<'static, Postgres>,
    epoch: String,
    operation: &str,
    fingerprint: String,
    subject: String,
    revision: i64,
) -> Result<operator::Receipt> {
    let receipt = operator::Receipt {
        operation_id: operation.into(),
        subject_id: subject,
        applied_revision: revision.to_string(),
    };
    sqlx::query("INSERT INTO operator_commands(operation_id,data_epoch,command_hash,receipt) VALUES($1,$2,$3,$4)").bind(operation).bind(epoch).bind(fingerprint).bind(Json(&receipt)).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(receipt)
}
pub async fn put(
    app: &App,
    operation: &str,
    name: &str,
    aliases: Vec<String>,
    expected: Option<&str>,
    input: Vec<u8>,
) -> Result<operator::Receipt> {
    let mut names = std::collections::HashSet::new();
    if aliases.len() > 8
        || !std::iter::once(name)
            .chain(aliases.iter().map(String::as_str))
            .all(|c| {
                rv_protocol::custom_emojis::shortcode(c) == Some(c)
                    && rv_protocol::emojis::canonical(c).is_none()
                    && names.insert(c)
            })
    {
        return Err(Error::invalid());
    }
    let fingerprint = auth::hash_token(
        &serde_json::json!([
            "emoji.put",
            name,
            aliases,
            expected,
            auth::hash_token_bytes(&input)
        ])
        .to_string(),
    );
    let (mut tx, epoch, old) = begin(app, operation, &fingerprint).await?;
    if let Some(old) = old {
        return Ok(old);
    }
    let existing: Option<(String, i64)> =
        sqlx::query_as("SELECT id,revision FROM custom_emojis WHERE name=$1")
            .bind(name)
            .fetch_optional(&mut *tx)
            .await?;
    if existing.is_some() && expected.is_none()
        || expected.is_some_and(|r| existing.as_ref().is_none_or(|e| e.1.to_string() != r))
    {
        return Err(Error::new(StatusCode::CONFLICT, "revision_conflict"));
    }
    let id = existing
        .as_ref()
        .map(|e| e.0.clone())
        .unwrap_or_else(auth::random_token);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM custom_emojis")
        .fetch_one(&mut *tx)
        .await?;
    if existing.is_none() && count >= 512 {
        return Err(Error::new(StatusCode::CONFLICT, "emoji_catalog_limit"));
    }
    for code in std::iter::once(name).chain(aliases.iter().map(String::as_str)) {
        let owner: Option<String> =
            sqlx::query_scalar("SELECT emoji_id FROM custom_emoji_codes WHERE code=$1")
                .bind(code)
                .fetch_optional(&mut *tx)
                .await?;
        if owner.is_some_and(|owner| owner != id) {
            return Err(Error::new(StatusCode::CONFLICT, "emoji_code_conflict"));
        }
    }
    let _slot = app
        .image_slots
        .acquire()
        .await
        .map_err(|_| Error::internal())?;
    let (bytes, mime) = tokio::task::spawn_blocking(move || decode(input))
        .await
        .map_err(|_| Error::internal())??;
    let digest = auth::hash_token_bytes(&bytes);
    let size = bytes.len() as i32;
    let object = app
        .objects
        .as_ref()
        .ok_or_else(|| Error::new(StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable"))?
        .put(bytes)
        .await?;
    let revision: i64 = sqlx::query_scalar(
        "UPDATE emoji_catalog SET revision=revision+1 WHERE singleton RETURNING revision",
    )
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO custom_emojis(id,name,aliases,object_id,sha256,media_type,bytes,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(name) DO UPDATE SET aliases=excluded.aliases,object_id=excluded.object_id,sha256=excluded.sha256,media_type=excluded.media_type,bytes=excluded.bytes,revision=excluded.revision").bind(&id).bind(name).bind(Json(&aliases)).bind(object).bind(&digest).bind(mime).bind(size).bind(revision).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM custom_emoji_codes WHERE emoji_id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    for code in std::iter::once(name).chain(aliases.iter().map(String::as_str)) {
        sqlx::query("INSERT INTO custom_emoji_codes VALUES($1,$2)")
            .bind(code)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    }
    operator::record(&mut tx,"emoji.put",&id,serde_json::json!({"name":name,"aliases":aliases,"revision":revision.to_string(),"sha256":digest,"bytes":size})).await?;
    finish(tx, epoch, operation, fingerprint, id, revision).await
}
pub async fn remove(
    app: &App,
    operation: &str,
    name: &str,
    expected: &str,
) -> Result<operator::Receipt> {
    let fingerprint =
        auth::hash_token(&serde_json::json!(["emoji.remove", name, expected]).to_string());
    let (mut tx, epoch, old) = begin(app, operation, &fingerprint).await?;
    if let Some(old) = old {
        return Ok(old);
    }
    let current: Option<(String, i64)> =
        sqlx::query_as("SELECT id,revision FROM custom_emojis WHERE name=$1")
            .bind(name)
            .fetch_optional(&mut *tx)
            .await?;
    let (id, revision) = current.ok_or_else(Error::missing)?;
    if revision.to_string() != expected {
        return Err(Error::new(StatusCode::CONFLICT, "revision_conflict"));
    }
    sqlx::query("DELETE FROM custom_emojis WHERE id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    let revision: i64 = sqlx::query_scalar(
        "UPDATE emoji_catalog SET revision=revision+1 WHERE singleton RETURNING revision",
    )
    .fetch_one(&mut *tx)
    .await?;
    operator::record(
        &mut tx,
        "emoji.remove",
        &id,
        serde_json::json!({"name":name,"revision":revision.to_string()}),
    )
    .await?;
    finish(tx, epoch, operation, fingerprint, id, revision).await
}
