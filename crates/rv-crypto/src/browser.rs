//! Worker-only virtual SQLite persistence. The browser host seals this complete
//! snapshot with a non-extractable WebCrypto key and commits it in IndexedDB
//! under its cross-tab Web Lock before returning a result or publishing a packet.
//! This is not a native OS keystore or an independent anti-rollback anchor.
use crate::vault::Error;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    collections::BTreeSet,
    path::{Path, PathBuf},
};

thread_local! { static PATHS: RefCell<BTreeSet<PathBuf>> = const { RefCell::new(BTreeSet::new()) }; }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Database {
    path: PathBuf,
    revision: i64,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    blobs: Vec<(Vec<u8>, Vec<u8>, Vec<u8>, i64)>,
}
pub fn exists(path: &Path) -> bool {
    PATHS.with(|paths| paths.borrow().contains(path))
}
pub(crate) fn created(path: &Path) {
    PATHS.with(|paths| {
        paths.borrow_mut().insert(path.into());
    });
}
pub fn remove(path: &Path) -> Result<(), Error> {
    let db = Connection::open(path).map_err(|_| Error::Storage)?;
    db.execute_batch("DROP TABLE IF EXISTS state; DROP TABLE IF EXISTS private_blobs;")
        .map_err(|_| Error::Storage)?;
    PATHS.with(|paths| {
        paths.borrow_mut().remove(path);
    });
    Ok(())
}
pub fn export() -> Result<Vec<Database>, Error> {
    PATHS.with(|paths| {
        paths
            .borrow()
            .iter()
            .map(|path| {
                let db = Connection::open(path).map_err(|_| Error::Storage)?;
                let (revision, nonce, ciphertext) = db
                    .query_row(
                        "SELECT revision,nonce,ciphertext FROM state WHERE singleton=1",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .map_err(|_| Error::Storage)?;
                let mut statement = db
                    .prepare("SELECT id,nonce,ciphertext,rekeyed FROM private_blobs ORDER BY id")
                    .map_err(|_| Error::Storage)?;
                let blobs = statement
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                    .map_err(|_| Error::Storage)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(|_| Error::Storage)?;
                Ok(Database {
                    path: path.clone(),
                    revision,
                    nonce,
                    ciphertext,
                    blobs,
                })
            })
            .collect()
    })
}
pub fn restore(databases: Vec<Database>) -> Result<(), Error> {
    if databases.len() > 4 {
        return Err(Error::Limit);
    }
    // Nothing in this worker owns a live MLS provider between operations.
    let old = PATHS.with(|paths| paths.borrow().clone());
    for path in old {
        remove(&path)?;
    }
    for value in databases {
        let name = value
            .path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or(Error::Scope)?;
        if value.path.parent() != Some(Path::new("/crypto"))
            || !name.starts_with("native-crypto-")
            || !name.ends_with(".sqlite")
            || value.nonce.len() != 24
            || value.ciphertext.len() > 16 * 1024 * 1024 + 16
            || value.revision < 0
            || value.blobs.len() > 65536
            || exists(&value.path)
        {
            return Err(Error::Integrity);
        }
        let mut db = Connection::open(&value.path).map_err(|_| Error::Storage)?;
        let tx = db.transaction().map_err(|_| Error::Storage)?;
        tx.execute_batch("CREATE TABLE state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,nonce BLOB NOT NULL,ciphertext BLOB NOT NULL);").map_err(|_| Error::Storage)?;
        crate::vault::blobs::initialize(&tx)?;
        tx.execute(
            "INSERT INTO state VALUES(1,?,?,?)",
            params![value.revision, value.nonce, value.ciphertext],
        )
        .map_err(|_| Error::Storage)?;
        for (id, nonce, ciphertext, rekeyed) in value.blobs {
            if id.len() != 16
                || nonce.len() != 24
                || ciphertext.len() > 1024 * 1024 + 48
                || ![0, 1].contains(&rekeyed)
            {
                return Err(Error::Integrity);
            }
            tx.execute(
                "INSERT INTO private_blobs VALUES(?,?,?,?)",
                params![id, nonce, ciphertext, rekeyed],
            )
            .map_err(|_| Error::Storage)?;
        }
        tx.commit().map_err(|_| Error::Storage)?;
        created(&value.path);
    }
    Ok(())
}
