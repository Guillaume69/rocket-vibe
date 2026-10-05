//! Immutable private blocks in the same SQL transaction as their protected refs.
use super::*;

pub const LIMIT: usize = 1024 * 1024;
const DOMAIN: &str = "rocketvibe-private-blob-v1";
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reference {
    pub id: [u8; 16],
    pub digest: [u8; 32],
}
impl Reference {
    fn valid(&self) -> bool {
        self.id != [0; 16] && self.digest != [0; 32]
    }
}
struct Row {
    nonce: [u8; 24],
    ciphertext: Vec<u8>,
}
fn aad(scope: &Scope, id: [u8; 16]) -> Result<Vec<u8>, Error> {
    serde_json::to_vec(&(DOMAIN, scope, id)).map_err(|_| Error::Scope)
}
fn digest(scope: &Scope, id: [u8; 16], row: &Row) -> Result<[u8; 32], Error> {
    let mut hash = Sha256::new();
    hash.update(aad(scope, id)?);
    hash.update(row.nonce);
    hash.update(&row.ciphertext);
    Ok(hash.finalize().into())
}
pub(super) fn initialize(db: &Connection) -> Result<(), Error> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS private_blobs(id BLOB PRIMARY KEY CHECK(length(id)=16),nonce BLOB NOT NULL CHECK(length(nonce)=24),ciphertext BLOB NOT NULL);")
        .map_err(|_| Error::Storage)
}
pub(super) fn empty(db: &Connection) -> Result<bool, Error> {
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='private_blobs')",
            [],
            |r| r.get(0),
        )
        .map_err(|_| Error::Storage)?;
    if !exists {
        return Ok(true);
    }
    db.query_row(
        "SELECT NOT EXISTS(SELECT 1 FROM private_blobs LIMIT 1)",
        [],
        |r| r.get(0),
    )
    .map_err(|_| Error::Storage)
}
/// Valid only inside the owned vault callback. No master key is exposed.
/// References must stay in protected records; an untrusted SQL list is not a catalog.
pub struct Access<'a> {
    db: &'a Connection,
    scope: &'a Scope,
    key: &'a Key,
    written: Vec<Reference>,
}
impl<'a> Access<'a> {
    pub(super) fn new(db: &'a Connection, scope: &'a Scope, key: &'a Key) -> Self {
        Self {
            db,
            scope,
            key,
            written: Vec::new(),
        }
    }
    pub fn read(&self, reference: &Reference) -> Result<Zeroizing<Vec<u8>>, Error> {
        if !reference.valid() {
            return Err(Error::Integrity);
        }
        // Check SQL lengths before allocating a caller-controlled BLOB.
        let (nonce, ciphertext): (Option<Vec<u8>>, Option<Vec<u8>>) = self.db.query_row(
            "SELECT CASE WHEN length(nonce)=24 THEN nonce END,CASE WHEN length(ciphertext) BETWEEN 16 AND ? THEN ciphertext END FROM private_blobs WHERE id=?",
            params![(LIMIT+16) as i64, reference.id.as_slice()], |r| Ok((r.get(0)?,r.get(1)?))
        ).map_err(|_|Error::Integrity)?;
        let row = Row {
            nonce: nonce
                .ok_or(Error::Integrity)?
                .try_into()
                .map_err(|_| Error::Integrity)?,
            ciphertext: ciphertext.ok_or(Error::Integrity)?,
        };
        if digest(self.scope, reference.id, &row)? != reference.digest {
            return Err(Error::Integrity);
        }
        let cipher =
            XChaCha20Poly1305::new_from_slice(self.key.0.as_ref()).map_err(|_| Error::Integrity)?;
        let clear = cipher
            .decrypt(
                XNonce::from_slice(&row.nonce),
                Payload {
                    msg: &row.ciphertext,
                    aad: &aad(self.scope, reference.id)?,
                },
            )
            .map_err(|_| Error::Integrity)?;
        Ok(Zeroizing::new(clear))
    }
    /// Always creates a fresh immutable block. The caller persists/reuses the
    /// original reference for retries; this API cannot silently replace a row.
    pub fn put(&mut self, bytes: &[u8]) -> Result<Reference, Error> {
        if bytes.len() > LIMIT || self.written.len() >= 1024 {
            return Err(Error::Limit);
        }
        let mut id = [0; 16];
        let mut nonce = [0; 24];
        getrandom::fill(&mut id).map_err(|_| Error::Storage)?;
        getrandom::fill(&mut nonce).map_err(|_| Error::Storage)?;
        if id == [0; 16] {
            return Err(Error::Storage);
        }
        let cipher =
            XChaCha20Poly1305::new_from_slice(self.key.0.as_ref()).map_err(|_| Error::Integrity)?;
        let row = Row {
            nonce,
            ciphertext: cipher
                .encrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: bytes,
                        aad: &aad(self.scope, id)?,
                    },
                )
                .map_err(|_| Error::Integrity)?,
        };
        let reference = Reference {
            id,
            digest: digest(self.scope, id, &row)?,
        };
        self.db
            .execute(
                "INSERT INTO private_blobs(id,nonce,ciphertext) VALUES(?,?,?)",
                params![id.as_slice(), row.nonce.as_slice(), row.ciphertext],
            )
            .map_err(|_| Error::Storage)?;
        self.written.push(reference);
        Ok(reference)
    }
    pub(super) fn verify_writes(&self) -> Result<(), Error> {
        for reference in &self.written {
            drop(self.read(reference)?);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
