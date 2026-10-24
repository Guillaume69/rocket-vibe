//! The last authenticated document of each vault in this process. An operation
//! that reads back the exact sealed row it last saw, under the same key and
//! protected checkpoint, shares it instead of decrypting and parsing it again.
//! Every operation still reads the row, so another process's commit is seen.
use super::{Checkpoint, Document, Key, Scope, Sealed};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

const LIMIT: usize = 4;

struct Entry {
    scope: Scope,
    key: [u8; 32],
    checkpoint: Checkpoint,
    revision: i64,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    document: Arc<Document>,
}
static ENTRIES: Mutex<Vec<Entry>> = Mutex::new(Vec::new());

fn key_digest(key: &Key) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(b"vibez-mls-vault-cache-v1");
    digest.update(key.0.as_ref());
    digest.finalize().into()
}
pub(super) fn find(
    scope: &Scope,
    key: &Key,
    row: &Sealed,
    expected: Checkpoint,
) -> Option<Arc<Document>> {
    let key = key_digest(key);
    let entries = ENTRIES.lock().ok()?;
    entries
        .iter()
        .find(|e| {
            e.checkpoint == expected
                && e.scope == *scope
                && e.key == key
                && e.revision == row.revision
                && e.nonce == row.nonce
                && e.ciphertext == row.ciphertext
        })
        .map(|e| e.document.clone())
}
pub(super) fn keep(
    scope: &Scope,
    key: &Key,
    row: &Sealed,
    checkpoint: Checkpoint,
    document: Arc<Document>,
) {
    let Ok(mut entries) = ENTRIES.lock() else {
        return;
    };
    entries.retain(|e| e.scope != *scope);
    if entries.len() >= LIMIT {
        entries.remove(0);
    }
    entries.push(Entry {
        scope: scope.clone(),
        key: key_digest(key),
        checkpoint,
        revision: row.revision,
        nonce: row.nonce.clone(),
        ciphertext: row.ciphertext.clone(),
        document,
    });
}
pub(crate) fn forget(scope: &Scope) {
    if let Ok(mut entries) = ENTRIES.lock() {
        entries.retain(|e| e.scope != *scope);
    }
}
