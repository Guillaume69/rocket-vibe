//! Read-only access to a Rocket.Chat database: documents as they are, and
//! the bytes of its files from GridFS or a FileSystem store.
use chrono::{DateTime, Utc};
use futures_util::{AsyncReadExt, TryStreamExt};
use mongodb::{
    Client, Database,
    bson::{Bson, Document, doc},
    options::GridFsBucketOptions,
};
use std::path::PathBuf;

use super::ImportError;

pub struct Source {
    db: Database,
    files_dir: Option<PathBuf>,
}

/// Field readers that tolerate what a long-lived Rocket.Chat database holds.
pub trait Fields {
    fn text(&self, key: &str) -> Option<&str>;
    fn flag(&self, key: &str) -> bool;
    fn time(&self, key: &str) -> Option<DateTime<Utc>>;
    fn strings(&self, key: &str) -> Vec<&str>;
    fn sub(&self, key: &str) -> Option<&Document>;
    fn number(&self, key: &str) -> i64;
}
impl Fields for Document {
    fn text(&self, key: &str) -> Option<&str> {
        self.get_str(key).ok()
    }
    fn flag(&self, key: &str) -> bool {
        self.get_bool(key).unwrap_or(false)
    }
    fn time(&self, key: &str) -> Option<DateTime<Utc>> {
        match self.get(key)? {
            Bson::DateTime(t) => DateTime::from_timestamp_millis(t.timestamp_millis()),
            _ => None,
        }
    }
    fn strings(&self, key: &str) -> Vec<&str> {
        self.get_array(key)
            .map(|items| items.iter().filter_map(Bson::as_str).collect())
            .unwrap_or_default()
    }
    fn sub(&self, key: &str) -> Option<&Document> {
        self.get_document(key).ok()
    }
    fn number(&self, key: &str) -> i64 {
        match self.get(key) {
            Some(Bson::Int32(n)) => i64::from(*n),
            Some(Bson::Int64(n)) => *n,
            Some(Bson::Double(n)) => *n as i64,
            _ => 0,
        }
    }
}

impl Source {
    pub async fn connect(url: &str, files_dir: Option<PathBuf>) -> Result<Self, ImportError> {
        let client = Client::with_uri_str(url).await?;
        let db = client
            .default_database()
            .ok_or_else(|| ImportError::new("the MongoDB URL names no database (…/rocketchat)"))?;
        // Fail early on a wrong address or credentials.
        db.run_command(doc! { "ping": 1 }).await?;
        Ok(Self { db, files_dir })
    }

    /// Rocket.Chat's version, for the report.
    pub async fn version(&self) -> Option<String> {
        let info = self
            .db
            .collection::<Document>("rocketchat_statistics")
            .find_one(doc! {})
            .await
            .ok()??;
        info.text("version").map(str::to_owned)
    }

    pub async fn all(&self, collection: &str) -> Result<Vec<Document>, ImportError> {
        Ok(self
            .db
            .collection::<Document>(collection)
            .find(doc! {})
            .await?
            .try_collect()
            .await?)
    }

    /// Messages of the imported rooms in time order, after `after` (`ts`, `_id`).
    pub async fn messages_after(
        &self,
        after: Option<(DateTime<Utc>, String)>,
        limit: i64,
    ) -> Result<Vec<Document>, ImportError> {
        let filter = match after {
            Some((ts, id)) => {
                let ts = mongodb::bson::DateTime::from_millis(ts.timestamp_millis());
                doc! { "$or": [ { "ts": { "$gt": ts } }, { "ts": ts, "_id": { "$gt": id } } ] }
            }
            None => doc! {},
        };
        Ok(self
            .db
            .collection::<Document>("rocketchat_message")
            .find(filter)
            .sort(doc! { "ts": 1, "_id": 1 })
            .limit(limit)
            .allow_disk_use(true)
            .await?
            .try_collect()
            .await?)
    }

    /// An uploaded file's metadata (`rocketchat_uploads`).
    pub async fn upload(&self, id: &str) -> Result<Option<Document>, ImportError> {
        Ok(self
            .db
            .collection::<Document>("rocketchat_uploads")
            .find_one(doc! { "_id": id })
            .await?)
    }

    /// A file's bytes from its store; `Err` names a store this import cannot read.
    pub async fn bytes(&self, store: &str, id: &str) -> Result<Vec<u8>, ImportError> {
        let bucket = match store {
            "GridFS:Uploads" => "rocketchat_uploads",
            "GridFS:Avatars" => "rocketchat_avatars",
            "FileSystem:Uploads" | "FileSystem:Avatars" => {
                let dir = self.files_dir.as_ref().ok_or_else(|| {
                    ImportError::new("unsupported_store: FileSystem needs --files-dir")
                })?;
                return Ok(tokio::fs::read(dir.join(id)).await?);
            }
            other => return Err(ImportError::new(&format!("unsupported_store: {other}"))),
        };
        self.gridfs(bucket, Bson::String(id.to_owned())).await
    }

    /// A custom emoji's image, stored by its file name (`name.extension`).
    pub async fn emoji(&self, file: &str) -> Result<Vec<u8>, ImportError> {
        let bucket = self.db.gridfs_bucket(
            GridFsBucketOptions::builder()
                .bucket_name("custom_emoji".to_owned())
                .build(),
        );
        let mut stream = bucket.open_download_stream_by_name(file).await?;
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await?;
        Ok(bytes)
    }

    async fn gridfs(&self, bucket: &str, id: Bson) -> Result<Vec<u8>, ImportError> {
        let bucket = self.db.gridfs_bucket(
            GridFsBucketOptions::builder()
                .bucket_name(bucket.to_owned())
                .build(),
        );
        let mut stream = bucket.open_download_stream(id).await?;
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await?;
        Ok(bytes)
    }
}
