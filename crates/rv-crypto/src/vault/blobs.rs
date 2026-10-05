//! Immutable private blocks in the same SQL transaction as their protected refs.
//! A storage key rotation re-seals every block under the new key with its
//! original digest inside (`rekeyed`), so references never change.
use super::*;

pub const LIMIT: usize = 1024 * 1024;
const DOMAIN: &str = "rocketvibe-private-blob-v1";
const REKEYED: &str = "rocketvibe-private-blob-rekeyed-v1";
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
fn rekeyed_aad(scope: &Scope, id: [u8; 16]) -> Result<Vec<u8>, Error> {
    serde_json::to_vec(&(REKEYED, scope, id)).map_err(|_| Error::Scope)
}
fn digest(scope: &Scope, id: [u8; 16], row: &Row) -> Result<[u8; 32], Error> {
    let mut hash = Sha256::new();
    hash.update(aad(scope, id)?);
    hash.update(row.nonce);
    hash.update(&row.ciphertext);
    Ok(hash.finalize().into())
}
pub(super) fn initialize(db: &Connection) -> Result<(), Error> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS private_blobs(id BLOB PRIMARY KEY CHECK(length(id)=16),nonce BLOB NOT NULL CHECK(length(nonce)=24),ciphertext BLOB NOT NULL,rekeyed INTEGER NOT NULL DEFAULT 0 CHECK(rekeyed IN (0,1)));")
        .map_err(|_| Error::Storage)?;
    migrate(db)
}
/// Blocks written before rotations existed gain the `rekeyed` marker, 0.
pub(super) fn migrate(db: &Connection) -> Result<(), Error> {
    let (table, column): (bool, bool) = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='private_blobs'),EXISTS(SELECT 1 FROM pragma_table_info('private_blobs') WHERE name='rekeyed')",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| Error::Storage)?;
    if table && !column {
        db.execute_batch("ALTER TABLE private_blobs ADD COLUMN rekeyed INTEGER NOT NULL DEFAULT 0 CHECK(rekeyed IN (0,1));")
            .map_err(|_| Error::Storage)?;
    }
    Ok(())
}
/// One stored block: its referenced digest and its content, under `key`.
fn open_row(
    db: &Connection,
    scope: &Scope,
    key: &Key,
    id: [u8; 16],
) -> Result<([u8; 32], Zeroizing<Vec<u8>>), Error> {
    // Check SQL lengths before allocating a caller-controlled BLOB.
    let (nonce, ciphertext, rekeyed): (Option<Vec<u8>>, Option<Vec<u8>>, i64) = db.query_row(
        "SELECT CASE WHEN length(nonce)=24 THEN nonce END,CASE WHEN length(ciphertext) BETWEEN 16 AND ? THEN ciphertext END,rekeyed FROM private_blobs WHERE id=?",
        params![(LIMIT+48) as i64, id.as_slice()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))
    ).map_err(|_|Error::Integrity)?;
    let row = Row {
        nonce: nonce
            .ok_or(Error::Integrity)?
            .try_into()
            .map_err(|_| Error::Integrity)?,
        ciphertext: ciphertext.ok_or(Error::Integrity)?,
    };
    let cipher = XChaCha20Poly1305::new_from_slice(key.0.as_ref()).map_err(|_| Error::Integrity)?;
    let open = |aad: &[u8]| {
        cipher
            .decrypt(
                XNonce::from_slice(&row.nonce),
                Payload {
                    msg: &row.ciphertext,
                    aad,
                },
            )
            .map(Zeroizing::new)
            .map_err(|_| Error::Integrity)
    };
    match rekeyed {
        0 if row.ciphertext.len() <= LIMIT + 16 => {
            let clear = open(&aad(scope, id)?)?;
            Ok((digest(scope, id, &row)?, clear))
        }
        // The original digest travels sealed with the content.
        1 => {
            let envelope = open(&rekeyed_aad(scope, id)?)?;
            if envelope.len() < 32 || envelope.len() > LIMIT + 32 {
                return Err(Error::Integrity);
            }
            let original: [u8; 32] = envelope[..32].try_into().map_err(|_| Error::Integrity)?;
            Ok((original, Zeroizing::new(envelope[32..].to_vec())))
        }
        _ => Err(Error::Integrity),
    }
}
/// Re-sealed block ids and the original digests they carry.
pub(super) type Resealed = Vec<([u8; 16], [u8; 32])>;
/// Re-seals every block from `old` to `next`, inside the rotation's commit;
/// the re-sealed ids and the digests they carry. A row the current key does
/// not open can never be read again: it is dropped rather than blocking every
/// rotation (and so keeping the old key alive).
pub(super) fn rekey(
    db: &Connection,
    scope: &Scope,
    old: &Key,
    next: &Key,
) -> Result<Resealed, Error> {
    let ids: Vec<Vec<u8>> = {
        let mut statement = db
            .prepare("SELECT id FROM private_blobs")
            .map_err(|_| Error::Storage)?;
        statement
            .query_map([], |r| r.get(0))
            .map_err(|_| Error::Storage)?
            .collect::<Result<_, _>>()
            .map_err(|_| Error::Storage)?
    };
    let cipher =
        XChaCha20Poly1305::new_from_slice(next.0.as_ref()).map_err(|_| Error::Integrity)?;
    let mut sealed = Vec::with_capacity(ids.len());
    for raw in ids {
        let Ok(id) = <[u8; 16]>::try_from(raw.as_slice()) else {
            db.execute("DELETE FROM private_blobs WHERE id=?", params![raw])
                .map_err(|_| Error::Storage)?;
            continue;
        };
        let (original, content) = match open_row(db, scope, old, id) {
            Ok(opened) => opened,
            Err(Error::Integrity) => {
                db.execute(
                    "DELETE FROM private_blobs WHERE id=?",
                    params![id.as_slice()],
                )
                .map_err(|_| Error::Storage)?;
                continue;
            }
            Err(error) => return Err(error),
        };
        let mut envelope = Zeroizing::new(Vec::with_capacity(32 + content.len()));
        envelope.extend_from_slice(&original);
        envelope.extend_from_slice(&content);
        let mut nonce = [0; 24];
        getrandom::fill(&mut nonce).map_err(|_| Error::Storage)?;
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &envelope,
                    aad: &rekeyed_aad(scope, id)?,
                },
            )
            .map_err(|_| Error::Integrity)?;
        db.execute(
            "UPDATE private_blobs SET nonce=?,ciphertext=?,rekeyed=1 WHERE id=?",
            params![nonce.as_slice(), ciphertext, id.as_slice()],
        )
        .map_err(|_| Error::Storage)?;
        sealed.push((id, original));
    }
    Ok(sealed)
}
/// Every re-sealed block opens under `next` with its original digest, read
/// back after the state update like `verify_writes`: a schema trigger that
/// restored old rows would otherwise lose them when the old key goes.
pub(super) fn verify_rekeyed(
    db: &Connection,
    scope: &Scope,
    next: &Key,
    sealed: &[([u8; 16], [u8; 32])],
) -> Result<(), Error> {
    for (id, original) in sealed {
        if open_row(db, scope, next, *id)?.0 != *original {
            return Err(Error::Integrity);
        }
    }
    Ok(())
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
        let (digest, clear) = open_row(self.db, self.scope, self.key, reference.id)?;
        if digest != reference.digest {
            return Err(Error::Integrity);
        }
        Ok(clear)
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
