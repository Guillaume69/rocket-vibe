//! The Rocket.Chat side: its MongoDB, read-only, and the bytes of its files
//! from GridFS or a FileSystem store directory.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use futures_util::{AsyncReadExt, TryStreamExt};
use mongodb::{
    Client, Database,
    bson::{Bson, Document, doc},
    options::GridFsBucketOptions,
};

use super::ImportResult;

/// Files larger than an upload may be (Vibez's own limit).
pub const MAX_FILE: u64 = 100 * 1024 * 1024;

pub struct Source {
    db: Database,
    uploads_dir: Option<PathBuf>,
}

impl Source {
    pub async fn connect(
        url: &str,
        database: &str,
        uploads_dir: Option<PathBuf>,
    ) -> ImportResult<Self> {
        let client = Client::with_uri_str(url).await?;
        let db = client.database(database);
        db.run_command(doc! {"ping": 1}).await?;
        Ok(Source { db, uploads_dir })
    }

    pub async fn all(
        &self,
        collection: &str,
        filter: Document,
        sort: Document,
    ) -> ImportResult<Vec<Document>> {
        Ok(self
            .db
            .collection::<Document>(collection)
            .find(filter)
            .sort(sort)
            .await?
            .try_collect()
            .await?)
    }

    pub async fn stream(
        &self,
        collection: &str,
        filter: Document,
        sort: Document,
    ) -> ImportResult<mongodb::Cursor<Document>> {
        Ok(self
            .db
            .collection::<Document>(collection)
            .find(filter)
            .sort(sort)
            .await?)
    }

    pub async fn count(&self, collection: &str, filter: Document) -> ImportResult<u64> {
        Ok(self
            .db
            .collection::<Document>(collection)
            .count_documents(filter)
            .await?)
    }

    pub async fn setting(&self, id: &str) -> ImportResult<Option<String>> {
        let found = self
            .db
            .collection::<Document>("rocketchat_settings")
            .find_one(doc! {"_id": id})
            .await?;
        Ok(found
            .as_ref()
            .and_then(|d| text(d, "value"))
            .filter(|v| !v.is_empty())
            .map(str::to_owned))
    }

    /// The bytes of a stored file (an upload or an avatar), by its document
    /// `_id` and `store` (`GridFS:Uploads`, `FileSystem:Avatars`, ...).
    /// `None`: stored somewhere the import cannot read (S3, Google Cloud,
    /// WebDAV), missing, or over the size limit.
    pub async fn file(
        &self,
        store: &str,
        id: &str,
        bucket: &str,
        size: u64,
    ) -> ImportResult<Option<Vec<u8>>> {
        if size > MAX_FILE {
            return Ok(None);
        }
        if store.starts_with("GridFS") {
            return self.gridfs(bucket, Bson::String(id.to_owned())).await;
        }
        if store.starts_with("FileSystem") {
            let Some(dir) = self.files_dir("FileUpload_FileSystemPath").await? else {
                return Ok(None);
            };
            return read_limited(&dir.join(id)).await;
        }
        Ok(None)
    }

    /// A custom emoji's image: `<name>.<extension>` in its GridFS bucket or
    /// FileSystem directory.
    pub async fn emoji(&self, name: &str, extension: &str) -> ImportResult<Option<Vec<u8>>> {
        let filename = format!("{name}.{extension}");
        if self.setting("EmojiUpload_Storage_Type").await?.as_deref() == Some("FileSystem") {
            let Some(dir) = self.files_dir("EmojiUpload_FileSystemPath").await? else {
                return Ok(None);
            };
            return read_limited(&dir.join(&filename)).await;
        }
        let Some(file) = self
            .db
            .collection::<Document>("custom_emoji.files")
            .find_one(doc! {"filename": &filename})
            .await?
        else {
            return Ok(None);
        };
        let Some(id) = file.get("_id").cloned() else {
            return Ok(None);
        };
        self.gridfs("custom_emoji", id).await
    }

    async fn gridfs(&self, bucket: &str, id: Bson) -> ImportResult<Option<Vec<u8>>> {
        let bucket = self.db.gridfs_bucket(
            GridFsBucketOptions::builder()
                .bucket_name(bucket.to_owned())
                .build(),
        );
        let mut stream = match bucket.open_download_stream(id).await {
            Ok(stream) => stream,
            Err(error) if matches!(*error.kind, mongodb::error::ErrorKind::GridFs(_)) => {
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        };
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await?;
        Ok(Some(bytes).filter(|b| !b.is_empty() && b.len() as u64 <= MAX_FILE))
    }

    /// `--uploads-dir` when given (a copy of the store elsewhere), else the
    /// path Rocket.Chat's setting names.
    async fn files_dir(&self, setting: &str) -> ImportResult<Option<PathBuf>> {
        if let Some(dir) = &self.uploads_dir {
            return Ok(Some(dir.clone()));
        }
        Ok(self.setting(setting).await?.map(PathBuf::from))
    }
}

async fn read_limited(path: &Path) -> ImportResult<Option<Vec<u8>>> {
    match tokio::fs::metadata(path).await {
        Ok(meta) if meta.is_file() && meta.len() > 0 && meta.len() <= MAX_FILE => {
            Ok(Some(tokio::fs::read(path).await?))
        }
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn text<'a>(doc: &'a Document, key: &str) -> Option<&'a str> {
    match doc.get(key) {
        Some(Bson::String(s)) => Some(s.as_str()),
        _ => None,
    }
}

pub fn id(doc: &Document) -> Option<String> {
    match doc.get("_id") {
        Some(Bson::String(s)) => Some(s.clone()),
        Some(Bson::ObjectId(o)) => Some(o.to_hex()),
        _ => None,
    }
}

pub fn flag(doc: &Document, key: &str) -> bool {
    matches!(doc.get(key), Some(Bson::Boolean(true)))
}

pub fn time(doc: &Document, key: &str) -> Option<DateTime<Utc>> {
    match doc.get(key) {
        Some(Bson::DateTime(t)) => DateTime::from_timestamp_millis(t.timestamp_millis()),
        _ => None,
    }
}

pub fn number(doc: &Document, key: &str) -> Option<u64> {
    match doc.get(key) {
        Some(Bson::Int32(n)) => u64::try_from(*n).ok(),
        Some(Bson::Int64(n)) => u64::try_from(*n).ok(),
        Some(Bson::Double(n)) if *n >= 0.0 => Some(*n as u64),
        _ => None,
    }
}

pub fn sub<'a>(doc: &'a Document, key: &str) -> Option<&'a Document> {
    match doc.get(key) {
        Some(Bson::Document(d)) => Some(d),
        _ => None,
    }
}

pub fn list<'a>(doc: &'a Document, key: &str) -> &'a [Bson] {
    match doc.get(key) {
        Some(Bson::Array(a)) => a,
        _ => &[],
    }
}

pub fn strings(doc: &Document, key: &str) -> Vec<String> {
    list(doc, key)
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}

/// A document as plain JSON (dates as RFC 3339), to keep in the archive tables.
pub fn json(doc: &Document) -> serde_json::Value {
    fn value(v: &Bson) -> serde_json::Value {
        match v {
            Bson::Document(d) => {
                serde_json::Value::Object(d.iter().map(|(k, v)| (k.clone(), value(v))).collect())
            }
            Bson::Array(a) => serde_json::Value::Array(a.iter().map(value).collect()),
            Bson::DateTime(t) => DateTime::from_timestamp_millis(t.timestamp_millis())
                .map(|t| serde_json::Value::String(t.to_rfc3339()))
                .unwrap_or(serde_json::Value::Null),
            Bson::ObjectId(o) => serde_json::Value::String(o.to_hex()),
            Bson::String(s) => serde_json::Value::String(s.clone()),
            Bson::Boolean(b) => serde_json::Value::Bool(*b),
            Bson::Int32(n) => (*n).into(),
            Bson::Int64(n) => (*n).into(),
            Bson::Double(n) => serde_json::Number::from_f64(*n)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null),
            Bson::Null | Bson::Undefined => serde_json::Value::Null,
            other => serde_json::Value::String(other.to_string()),
        }
    }
    value(&Bson::Document(doc.clone()))
}
