//! Immutable objects on an operator-owned volume. SQL references only finalized objects.
use crate::{
    auth,
    error::{Error, Result},
};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone)]
pub struct LocalObjects {
    root: PathBuf,
    scan_after: std::sync::Arc<std::sync::Mutex<String>>,
}

impl LocalObjects {
    pub fn open(root: impl AsRef<Path>) -> std::io::Result<Self> {
        fs::create_dir_all(root.as_ref())?;
        Ok(Self {
            root: fs::canonicalize(root)?,
            scan_after: Default::default(),
        })
    }

    fn path(&self, id: &str) -> Result<PathBuf> {
        if id.len() != 64
            || !id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::invalid());
        }
        Ok(self.root.join(id))
    }

    pub(crate) async fn put(&self, bytes: Vec<u8>) -> Result<String> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let id = auth::random_token();
            let temporary = store.root.join(format!(".tmp-{id}"));
            let result = (|| -> std::io::Result<()> {
                let mut file = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&temporary)?;
                file.write_all(&bytes)?;
                file.sync_all()?;
                fs::rename(&temporary, store.root.join(&id))?;
                // Sync the containing directory before publishing the SQL reference.
                #[cfg(unix)]
                File::open(&store.root)?.sync_all()?;
                Ok(())
            })();
            if result.is_err() {
                let _ = fs::remove_file(&temporary);
            }
            result.map_err(|error| {
                tracing::error!(%error,"object finalization failed");
                Error::internal()
            })?;
            Ok(id)
        })
        .await
        .map_err(|_| Error::internal())?
    }

    pub(crate) async fn read(&self, id: &str, max_bytes: u64) -> Result<Vec<u8>> {
        let path = self.path(id)?;
        tokio::task::spawn_blocking(move || {
            let mut bytes = Vec::new();
            File::open(path)
                .and_then(|file| file.take(max_bytes + 1).read_to_end(&mut bytes))
                .map_err(|_| Error::missing())?;
            if bytes.len() as u64 > max_bytes {
                return Err(Error::internal());
            }
            Ok(bytes)
        })
        .await
        .map_err(|_| Error::internal())?
    }

    pub(crate) async fn remove(&self, id: &str) -> Result<()> {
        let path = self.path(id)?;
        tokio::task::spawn_blocking(move || match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => {
                tracing::warn!(error=%e,"object retirement failed");
                Err(Error::internal())
            }
        })
        .await
        .map_err(|_| Error::internal())?
    }

    /// Crash/rollback garbage only. Newly finalized objects receive a full hour
    /// before inspection; no transaction can publish that late (10s DB deadline).
    pub(crate) async fn collect(&self, pool: &sqlx::PgPool) -> Result<()> {
        let root = self.root.clone();
        let after = self.scan_after.lock().expect("object scan cursor").clone();
        let candidates =
            tokio::task::spawn_blocking(move || -> std::io::Result<Vec<(String, bool)>> {
                let mut found = std::collections::BTreeMap::new();
                for entry in fs::read_dir(root)? {
                    let entry = entry?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name <= after {
                        continue;
                    }
                    if !entry.file_type()?.is_file()
                        || !entry
                            .metadata()?
                            .modified()?
                            .elapsed()
                            .is_ok_and(|age| age > Duration::from_secs(3600))
                    {
                        continue;
                    }
                    let temporary = name.starts_with(".tmp-");
                    let id = name.strip_prefix(".tmp-").unwrap_or(&name);
                    if id.len() == 64
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    {
                        found.insert(name, temporary);
                        if found.len() > 128 {
                            found.pop_last();
                        }
                    }
                }
                Ok(found.into_iter().collect())
            })
            .await
            .map_err(|_| Error::internal())?
            .map_err(|_| Error::internal())?;
        // Advance through active files too, so they cannot starve crash garbage.
        *self.scan_after.lock().expect("object scan cursor") = candidates
            .last()
            .map(|(name, _)| name.clone())
            .unwrap_or_default();
        for (name, temporary) in candidates {
            if !temporary {
                let used: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM users WHERE avatar_file_id=$1)",
                )
                .bind(&name)
                .fetch_one(pool)
                .await?;
                if used {
                    continue;
                }
                self.remove(&name).await?;
            } else {
                // The name was restricted above, never derived from an HTTP path.
                let path = self.root.join(name);
                let _ = tokio::fs::remove_file(path).await;
            }
        }
        Ok(())
    }
}
