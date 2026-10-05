//! Authenticated MLS storage and private operation records in one SQLite commit.
//! A protected checkpoint is mandatory on reopen. Platform adapters must persist
//! each returned checkpoint before publishing results; see RFC 0002.
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use openmls::prelude::OpenMlsProvider;
use openmls_rust_crypto::OpenMlsRustCrypto;
use rusqlite::{Connection, OpenFlags, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    path::Path,
    time::Duration,
};
use zeroize::{Zeroize, Zeroizing};

const DOMAIN: &str = "rocketvibe-mls-vault-v1";
const LIMIT: usize = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 65536;
pub mod blobs;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("crypto_storage_unavailable")]
    Storage,
    #[error("crypto_integrity_failed")]
    Integrity,
    #[error("crypto_checkpoint_changed")]
    Stale,
    #[error("crypto_state_limit")]
    Limit,
    #[error("crypto_operation_rejected")]
    Rejected,
    #[error("crypto_invalid_scope")]
    Scope,
    #[error("crypto_checkpoint_pending")]
    Pending,
    #[error("crypto_storage_busy")]
    Busy,
    #[error("crypto_not_initialized")]
    NotInitialized,
    #[error("crypto_device_retired")]
    Retired,
}

/// The platform keystore owns this secret. It is never printable or cloned.
pub struct Key(Zeroizing<[u8; 32]>);
impl Key {
    pub fn generate() -> Result<Self, Error> {
        let mut bytes = Zeroizing::new([0; 32]);
        getrandom::fill(bytes.as_mut()).map_err(|_| Error::Storage)?;
        Ok(Self(bytes))
    }
    pub fn from_keystore(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }
    /// Only for an authenticated platform-keystore write, before creating the DB.
    pub fn for_keystore(&self) -> &[u8; 32] {
        &self.0
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub instance: String,
    pub data_epoch: String,
    pub user: String,
    pub device: String,
    pub incarnation: String,
}
impl Scope {
    pub(crate) fn valid(&self) -> bool {
        [
            &self.instance,
            &self.data_epoch,
            &self.user,
            &self.device,
            &self.incarnation,
        ]
        .iter()
        .all(|v| !v.is_empty() && v.len() <= 256 && !v.chars().any(char::is_control))
    }
}

/// Public integrity marker to save with the protected key, outside this DB.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub revision: i64,
    pub digest: [u8; 32],
}

/// Auxiliary outbox/receipt/cache records are encrypted with the MLS state.
pub type Records = BTreeMap<String, Vec<u8>>;

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    previous: Option<Checkpoint>,
    mls: Vec<(Vec<u8>, Vec<u8>)>,
    records: Records,
}
impl Drop for Document {
    fn drop(&mut self) {
        for (key, value) in &mut self.mls {
            key.zeroize();
            value.zeroize();
        }
        while let Some((mut key, mut value)) = self.records.pop_first() {
            key.zeroize();
            value.zeroize();
        }
    }
}
struct Working {
    provider: OpenMlsRustCrypto,
    records: Records,
}
impl Working {
    fn from_document(mut document: Document) -> Result<Self, Error> {
        if document.mls.len() > MAX_ENTRIES || document.records.len() > MAX_ENTRIES {
            return Err(Error::Limit);
        }
        let working = Self {
            provider: OpenMlsRustCrypto::default(),
            records: std::mem::take(&mut document.records),
        };
        {
            let mut values = working
                .provider
                .storage()
                .values
                .write()
                .map_err(|_| Error::Storage)?;
            while let Some((mut key, mut value)) = document.mls.pop() {
                if key.is_empty()
                    || key.len() > LIMIT
                    || value.len() > LIMIT
                    || values.contains_key(&key)
                {
                    key.zeroize();
                    value.zeroize();
                    return Err(Error::Integrity);
                }
                values.insert(key, value);
            }
        }
        Ok(working)
    }
    fn document(&self) -> Result<Document, Error> {
        let values = self
            .provider
            .storage()
            .values
            .read()
            .map_err(|_| Error::Storage)?;
        if values.len() > MAX_ENTRIES || self.records.len() > MAX_ENTRIES {
            return Err(Error::Limit);
        }
        if self.records.iter().any(|(key, value)| {
            key.is_empty()
                || key.len() > 256
                || key.chars().any(char::is_control)
                || value.len() > LIMIT
        }) {
            return Err(Error::Limit);
        }
        let estimate = values
            .iter()
            .map(|(k, v)| {
                k.len()
                    .checked_add(v.len())
                    .and_then(|n| n.checked_mul(4))
                    .and_then(|n| n.checked_add(32))
            })
            .chain(self.records.iter().map(|(k, v)| {
                k.len()
                    .checked_mul(6)
                    .and_then(|n| v.len().checked_mul(4).and_then(|v| n.checked_add(v)))
                    .and_then(|n| n.checked_add(32))
            }))
            .try_fold(1024usize, |total, n| n.and_then(|n| total.checked_add(n)))
            .ok_or(Error::Limit)?;
        if estimate > LIMIT {
            return Err(Error::Limit);
        }
        let mut mls: Vec<_> = values.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        mls.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(Document {
            previous: None,
            mls,
            records: self.records.clone(),
        })
    }
}
impl Drop for Working {
    fn drop(&mut self) {
        if let Ok(mut values) = self.provider.storage().values.write() {
            for (mut key, mut value) in values.drain() {
                key.zeroize();
                value.zeroize();
            }
        }
        while let Some((mut key, mut value)) = self.records.pop_first() {
            key.zeroize();
            value.zeroize();
        }
    }
}

struct Sealed {
    revision: i64,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}
fn aad(scope: &Scope, revision: i64) -> Result<Vec<u8>, Error> {
    serde_json::to_vec(&(DOMAIN, scope, revision)).map_err(|_| Error::Scope)
}
fn checkpoint(scope: &Scope, row: &Sealed) -> Result<Checkpoint, Error> {
    let mut digest = Sha256::new();
    digest.update(aad(scope, row.revision)?);
    digest.update(&row.nonce);
    digest.update(&row.ciphertext);
    Ok(Checkpoint {
        revision: row.revision,
        digest: digest.finalize().into(),
    })
}
fn seal(scope: &Scope, key: &Key, revision: i64, document: &Document) -> Result<Sealed, Error> {
    let plaintext = Zeroizing::new(serde_json::to_vec(document).map_err(|_| Error::Integrity)?);
    if plaintext.len() > LIMIT {
        return Err(Error::Limit);
    }
    let mut nonce = [0; 24];
    getrandom::fill(&mut nonce).map_err(|_| Error::Storage)?;
    let cipher = XChaCha20Poly1305::new_from_slice(key.0.as_ref()).map_err(|_| Error::Integrity)?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: &aad(scope, revision)?,
            },
        )
        .map_err(|_| Error::Integrity)?;
    Ok(Sealed {
        revision,
        nonce: nonce.to_vec(),
        ciphertext,
    })
}
fn unseal(scope: &Scope, key: &Key, row: &Sealed, expected: Checkpoint) -> Result<Working, Error> {
    if checkpoint(scope, row)? != expected {
        return Err(Error::Stale);
    }
    Working::from_document(decode(scope, key, row)?)
}
fn decode(scope: &Scope, key: &Key, row: &Sealed) -> Result<Document, Error> {
    let cipher = XChaCha20Poly1305::new_from_slice(key.0.as_ref()).map_err(|_| Error::Integrity)?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                XNonce::from_slice(&row.nonce),
                Payload {
                    msg: &row.ciphertext,
                    aad: &aad(scope, row.revision)?,
                },
            )
            .map_err(|_| Error::Integrity)?,
    );
    let document: Document = serde_json::from_slice(&plaintext).map_err(|_| Error::Integrity)?;
    if !match document.previous {
        None => row.revision == 0,
        Some(previous) => {
            previous.revision >= 0 && previous.revision.checked_add(1) == Some(row.revision)
        }
    } {
        return Err(Error::Integrity);
    }
    Ok(document)
}
fn read(connection: &Connection) -> Result<Sealed, Error> {
    let (revision, nonce, ciphertext): (i64, Option<Vec<u8>>, Option<Vec<u8>>) = connection.query_row(
        "SELECT revision,CASE WHEN length(nonce)=24 THEN nonce END,CASE WHEN length(ciphertext) BETWEEN 16 AND ? THEN ciphertext END FROM state WHERE singleton=1",
        [(LIMIT + 16) as i64], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(|_| Error::Storage)?;
    if revision < 0 {
        return Err(Error::Integrity);
    }
    Ok(Sealed {
        revision,
        nonce: nonce.ok_or(Error::Integrity)?,
        ciphertext: ciphertext.ok_or(Error::Integrity)?,
    })
}
fn connection(path: &Path) -> Result<Connection, Error> {
    let metadata = fs::symlink_metadata(path).map_err(|_| Error::Storage)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(Error::Storage);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 || metadata.nlink() != 1 {
            return Err(Error::Storage);
        }
    }
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| Error::Storage)?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|_| Error::Storage)?;
    db.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY;").map_err(|_| Error::Storage)?;
    Ok(db)
}

pub struct Vault {
    db: Connection,
    scope: Scope,
    key: Key,
    checkpoint: Checkpoint,
    pending: bool,
}
impl Vault {
    /// The parent directory must be private and owned by the current OS user.
    /// Existing files are never overwritten; an unavailable key is not absence.
    pub fn create(path: &Path, scope: Scope, key: Key) -> Result<Self, Error> {
        if !scope.valid() {
            return Err(Error::Scope);
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(path).map_err(|_| Error::Storage)?;
        file.sync_all().map_err(|_| Error::Storage)?;
        drop(file);
        let mut db = connection(path)?;
        let row = seal(&scope, &key, 0, &Document::default())?;
        let checkpoint = checkpoint(&scope, &row)?;
        let transaction = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::Storage)?;
        transaction.execute_batch("CREATE TABLE state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,nonce BLOB NOT NULL,ciphertext BLOB NOT NULL);").map_err(|_| Error::Storage)?;
        blobs::initialize(&transaction)?;
        transaction
            .execute(
                "INSERT INTO state VALUES(1,?,?,?)",
                params![row.revision, row.nonce, row.ciphertext],
            )
            .map_err(|_| Error::Storage)?;
        transaction.commit().map_err(|_| Error::Storage)?;
        #[cfg(unix)]
        {
            // Make the new directory entry durable before its checkpoint can
            // be saved outside SQLite. The private parent is a caller contract.
            let parent = path.parent().filter(|p| !p.as_os_str().is_empty());
            fs::File::open(parent.unwrap_or(Path::new(".")))
                .and_then(|directory| directory.sync_all())
                .map_err(|_| Error::Storage)?;
        }
        Ok(Self {
            db,
            scope,
            key,
            checkpoint,
            pending: true,
        })
    }
    /// The checkpoint comes from protected platform storage, never this DB.
    pub fn open(
        path: &Path,
        scope: Scope,
        key: Key,
        checkpoint: Checkpoint,
    ) -> Result<Self, Error> {
        if !scope.valid() {
            return Err(Error::Scope);
        }
        let db = connection(path)?;
        drop(unseal(&scope, &key, &read(&db)?, checkpoint)?);
        Ok(Self {
            db,
            scope,
            key,
            checkpoint,
            pending: false,
        })
    }
    pub fn checkpoint(&self) -> Checkpoint {
        self.checkpoint
    }
    /// Recover only a pristine genesis while the protected key is still marked
    /// initializing. No MLS identity, message or private record may exist yet.
    pub(crate) fn recover_initial(path: &Path, scope: Scope, key: Key) -> Result<Self, Error> {
        if !scope.valid() {
            return Err(Error::Scope);
        }
        let db = connection(path)?;
        let row = read(&db)?;
        if row.revision != 0 {
            return Err(Error::Stale);
        }
        let document = decode(&scope, &key, &row)?;
        if !document.mls.is_empty() || !document.records.is_empty() || !blobs::empty(&db)? {
            return Err(Error::Integrity);
        }
        let checkpoint = checkpoint(&scope, &row)?;
        Ok(Self {
            db,
            scope,
            key,
            checkpoint,
            pending: true,
        })
    }
    /// Invoke only after the platform has durably saved this exact checkpoint.
    pub fn checkpoint_persisted(&mut self, checkpoint: Checkpoint) -> Result<(), Error> {
        if checkpoint != self.checkpoint {
            return Err(Error::Stale);
        }
        self.pending = false;
        Ok(())
    }
    /// A crash after SQLite commit but before a keystore write is recoverable
    /// only one step ahead, with the protected predecessor authenticated inside.
    /// Reading and further transactions stay blocked until the new stamp is saved.
    pub fn recover_committed(
        path: &Path,
        scope: Scope,
        key: Key,
        protected: Checkpoint,
    ) -> Result<Self, Error> {
        if !scope.valid() {
            return Err(Error::Scope);
        }
        let db = connection(path)?;
        let row = read(&db)?;
        if protected.revision.checked_add(1) != Some(row.revision) {
            return Err(Error::Stale);
        }
        let document = decode(&scope, &key, &row)?;
        if document.previous != Some(protected) {
            return Err(Error::Stale);
        }
        drop(Working::from_document(document)?);
        let checkpoint = checkpoint(&scope, &row)?;
        Ok(Self {
            db,
            scope,
            key,
            checkpoint,
            pending: true,
        })
    }
    /// Read through a fresh provider; mutations in this callback are discarded.
    /// A group/provider must not escape the callback for a later operation.
    pub fn inspect<T>(
        &self,
        operation: impl FnOnce(&OpenMlsRustCrypto, &Records) -> Result<T, Error>,
    ) -> Result<T, Error> {
        self.inspect_with_blobs(|provider, records, _| operation(provider, records))
    }
    pub fn inspect_with_blobs<T>(
        &self,
        operation: impl FnOnce(&OpenMlsRustCrypto, &Records, &blobs::Access<'_>) -> Result<T, Error>,
    ) -> Result<T, Error> {
        if self.pending {
            return Err(Error::Pending);
        }
        let working = unseal(&self.scope, &self.key, &read(&self.db)?, self.checkpoint)?;
        let blobs = blobs::Access::new(&self.db, &self.scope, &self.key);
        operation(&working.provider, &working.records, &blobs)
    }
    /// Successful provider writes and private operation records become durable
    /// together. On any error, the temporary provider/group is discarded entirely.
    /// The returned result MUST NOT be delivered until its checkpoint is protected.
    pub fn transact<T>(
        &mut self,
        operation: impl FnOnce(&OpenMlsRustCrypto, &mut Records) -> Result<T, Error>,
    ) -> Result<(T, Checkpoint), Error> {
        self.transact_with_blobs(|provider, records, _| operation(provider, records))
    }
    /// Private blocks and references commit with MLS, then remain unavailable
    /// until the exact checkpoint is persisted outside SQLite.
    pub fn transact_with_blobs<T>(
        &mut self,
        operation: impl FnOnce(
            &OpenMlsRustCrypto,
            &mut Records,
            &mut blobs::Access<'_>,
        ) -> Result<T, Error>,
    ) -> Result<(T, Checkpoint), Error> {
        if self.pending {
            return Err(Error::Pending);
        }
        let transaction = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::Storage)?;
        let mut working = unseal(
            &self.scope,
            &self.key,
            &read(&transaction)?,
            self.checkpoint,
        )?;
        blobs::initialize(&transaction)?;
        let mut blobs = blobs::Access::new(&transaction, &self.scope, &self.key);
        let result = operation(&working.provider, &mut working.records, &mut blobs)?;
        let revision = self
            .checkpoint
            .revision
            .checked_add(1)
            .ok_or(Error::Limit)?;
        let mut document = working.document()?;
        document.previous = Some(self.checkpoint);
        let row = seal(&self.scope, &self.key, revision, &document)?;
        let next = checkpoint(&self.scope, &row)?;
        transaction
            .execute(
                "UPDATE state SET revision=?,nonce=?,ciphertext=? WHERE singleton=1",
                params![row.revision, row.nonce, row.ciphertext],
            )
            .map_err(|_| Error::Storage)?;
        // Also catches a malicious schema trigger that alters a block during
        // the state UPDATE. No callback output escapes on this failure.
        blobs.verify_writes()?;
        drop(blobs);
        #[cfg(test)]
        crash_boundary("before-commit");
        transaction.commit().map_err(|_| Error::Storage)?;
        self.checkpoint = next;
        self.pending = true;
        #[cfg(test)]
        crash_boundary("after-commit");
        Ok((result, next))
    }
}

#[cfg(test)]
fn crash_boundary(boundary: &str) {
    if std::env::var("RV_CRYPTO_TEST_KILL").as_deref() == Ok(boundary) {
        use std::io::Write;
        println!("crypto-test-at-boundary");
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::park();
        }
    }
}

#[cfg(test)]
mod tests;
