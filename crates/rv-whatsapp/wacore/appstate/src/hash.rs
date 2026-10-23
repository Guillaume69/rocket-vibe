//! A collection's integrity state and the MACs computed over it.
//!
//! Several rules here look odd and are deliberate: they reproduce WhatsApp
//! Web's own arithmetic (`WAWebSyncdAntiTampering`, `WAWebSyncdCrypto`),
//! because the snapshot and patch MACs the server hands out were computed by
//! clients running it. A rule that is "more correct" than theirs is a
//! collection that never verifies again.

use std::collections::HashMap;

use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use serde_big_array::BigArray;
use sha2::Sha512;
use waproto::whatsapp as wa;

use crate::crypto::hmac_sha256;
use crate::{AppStateError, WAPATCH_INTEGRITY};

type Operation = wa::syncd_mutation::SyncdOperation;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HashState {
    pub version: u64,
    #[serde(with = "BigArray")]
    pub hash: [u8; 128],
    pub index_value_map: HashMap<String, Vec<u8>>,
    /// The hash stopped agreeing with the server's: set the first time a
    /// patch's snapshot MAC fails, after which that comparison is skipped
    /// (WhatsApp Web's `isCollectionInMacMismatchFatal`). The patch MAC, the
    /// one proving authorship, is still checked on every patch. A snapshot
    /// rebuilds the hash and clears it.
    #[serde(default)]
    pub mac_mismatch_fatal: bool,
    /// A bootstrap reached its last page. Version 0 cannot tell "never
    /// synced" from "synced and empty"; this can, and a state written before
    /// it existed reads as false and bootstraps once more.
    #[serde(default)]
    pub bootstrapped: bool,
}

impl Default for HashState {
    fn default() -> Self {
        Self {
            version: 0,
            hash: [0; 128],
            index_value_map: HashMap::new(),
            mac_mismatch_fatal: false,
            bootstrapped: false,
        }
    }
}

/// What a snapshot fold did with the records it was given.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FoldReport {
    /// Value MACs that entered the hash, one per distinct index.
    pub folded: usize,
    /// Records with no index MAC: they all share one key, so together they
    /// fold at most one value MAC.
    pub unkeyed: usize,
    /// Records with no value blob, which fold nothing.
    pub valueless: usize,
}

#[derive(Debug, Clone, Default)]
pub struct HashUpdateResult {
    /// A REMOVE whose previous value this device never had: telemetry for a
    /// MAC failure, never a reason to forgive one.
    pub has_missing_remove: bool,
}

impl HashState {
    /// Whether there is a hash to apply patches to: a version past zero, or
    /// a bootstrap that finished on an empty collection.
    pub fn has_baseline(&self) -> bool {
        self.bootstrapped || self.version > 0
    }

    /// Folds a patch's mutations in. `get_prev_set_value_mac(index_mac, i)`
    /// answers the value MAC the index held before mutation `i`.
    ///
    /// When every mutation carries an index, a SET whose index the same patch
    /// also REMOVEs subtracts nothing: the REMOVE owns that subtraction.
    pub fn update_hash<F>(
        &mut self,
        mutations: &[wa::SyncdMutation],
        mut get_prev_set_value_mac: F,
    ) -> (HashUpdateResult, anyhow::Result<()>)
    where
        F: FnMut(&[u8], usize) -> anyhow::Result<Option<Vec<u8>>>,
    {
        let mut result = HashUpdateResult::default();
        let every_indexed = mutations.iter().all(|m| index_mac_of(m).is_some());
        let removed_here: Vec<&[u8]> = if every_indexed {
            mutations
                .iter()
                .filter(|m| is_remove(m))
                .filter_map(index_mac_of)
                .collect()
        } else {
            Vec::new()
        };
        let mut added: Vec<&[u8]> = Vec::new();
        let mut removed: Vec<Vec<u8>> = Vec::new();
        for (i, mutation) in mutations.iter().enumerate() {
            let op = match operation(mutation) {
                Ok(op) => op,
                Err(e) => return (result, Err(anyhow::anyhow!(e))),
            };
            let set = op == Operation::SET;
            if set
                && mutation.record.is_set()
                && let Some(blob) = &mutation.record.value.blob
            {
                added.push(value_mac_tail(blob));
            }
            let Some(index_mac) = index_mac_of(mutation) else {
                continue;
            };
            if set && removed_here.contains(&index_mac) {
                continue;
            }
            match get_prev_set_value_mac(index_mac, i) {
                Ok(Some(previous)) => removed.push(previous),
                Ok(None) if op == Operation::REMOVE => result.has_missing_remove = true,
                Ok(None) => {}
                Err(e) => return (result, Err(e)),
            }
        }
        WAPATCH_INTEGRITY.subtract_then_add_in_place(&mut self.hash, &removed, &added);
        (result, Ok(()))
    }

    /// Folds a snapshot's records in. A snapshot is a map from index to
    /// record: when an index repeats, the last record wins, and every record
    /// without an index shares the empty one.
    pub fn update_hash_from_records(&mut self, records: &[wa::SyncdRecord]) -> FoldReport {
        let mut last: HashMap<&[u8], &[u8]> = HashMap::with_capacity(records.len());
        let (mut unkeyed, mut valueless) = (0, 0);
        for record in records {
            let Some(blob) = record.value.blob.as_deref() else {
                valueless += 1;
                continue;
            };
            let index = record
                .index
                .as_option()
                .and_then(|i| i.blob.as_deref())
                .unwrap_or_default();
            if index.is_empty() {
                unkeyed += 1;
            }
            last.insert(index, value_mac_tail(blob));
        }
        let added: Vec<&[u8]> = last.into_values().collect();
        WAPATCH_INTEGRITY.subtract_then_add_in_place(&mut self.hash, &[] as &[&[u8]], &added);
        FoldReport {
            folded: added.len(),
            unkeyed,
            valueless,
        }
    }

    pub fn generate_snapshot_mac(&self, name: &str, key: &[u8]) -> Vec<u8> {
        hmac_sha256(
            key,
            &[&self.hash, &network_order(self.version), name.as_bytes()],
        )
        .to_vec()
    }
}

fn index_mac_of(mutation: &wa::SyncdMutation) -> Option<&[u8]> {
    mutation
        .record
        .as_option()?
        .index
        .as_option()?
        .blob
        .as_deref()
}

fn is_remove(mutation: &wa::SyncdMutation) -> bool {
    mutation.operation.is_some_and(|op| op == Operation::REMOVE)
}

/// A mutation's operation: absent means SET (the proto2 default), an
/// unknown value is refused.
pub(crate) fn operation(mutation: &wa::SyncdMutation) -> Result<Operation, AppStateError> {
    match mutation.operation {
        None => Ok(Operation::SET),
        Some(v) => match v.as_known() {
            Some(op @ (Operation::SET | Operation::REMOVE)) => Ok(op),
            _ => Err(AppStateError::UnsupportedSyncdOperation(v.to_i32())),
        },
    }
}

/// The trailing bytes of a value blob that stand for its MAC, by WhatsApp
/// Web's `slice(len - 32)`: on a blob shorter than 32 bytes the negative
/// start counts from the end again, so it starts at `2 * len - 32`.
pub(crate) fn value_mac_tail(blob: &[u8]) -> &[u8] {
    let len = blob.len();
    let start = if len >= 32 {
        len - 32
    } else {
        (2 * len).saturating_sub(32)
    };
    &blob[start..]
}

/// WhatsApp Web's `to64BitNetworkOrder`: eight bytes, the version modulo
/// 2^32 big-endian in the last four.
fn network_order(version: u64) -> [u8; 8] {
    if version > u64::from(u32::MAX) {
        log::warn!(
            "app-state version {version} does not fit 32 bits; its MACs use {}",
            version as u32
        );
    }
    let mut out = [0u8; 8];
    out[4..].copy_from_slice(&(version as u32).to_be_bytes());
    out
}

/// The patch MAC: the patch's snapshot MAC, every mutation's value MAC (a
/// REMOVE's included), then the version and the collection name.
pub fn generate_patch_mac(patch: &wa::SyncdPatch, name: &str, key: &[u8], version: u64) -> Vec<u8> {
    let mut parts: Vec<&[u8]> = Vec::new();
    if let Some(snapshot_mac) = &patch.snapshot_mac {
        parts.push(snapshot_mac);
    }
    for m in &patch.mutations {
        if m.record.is_set()
            && let Some(blob) = &m.record.value.blob
        {
            parts.push(value_mac_tail(blob));
        }
    }
    let version = network_order(version);
    parts.push(&version);
    parts.push(name.as_bytes());
    hmac_sha256(key, &parts).to_vec()
}

/// A record's value MAC: HMAC-SHA512 over the operation (SET 1, REMOVE 2),
/// the key id, the IV and ciphertext, then eight bytes whose last one is the
/// key id's length plus one; truncated to 32 bytes.
pub fn generate_content_mac(
    operation: Operation,
    data: &[u8],
    key_id: &[u8],
    key: &[u8],
) -> [u8; 32] {
    let mut length = [0u8; 8];
    length[7] = ((key_id.len() + 1) & 0xff) as u8;
    let mut mac = <Hmac<Sha512> as KeyInit>::new_from_slice(key).expect("any key length");
    mac.update(&[operation as u8 + 1]);
    mac.update(key_id);
    mac.update(data);
    mac.update(&length);
    mac.finalize().into_bytes()[..32]
        .try_into()
        .expect("32 bytes")
}

pub fn generate_index_mac(index_json_bytes: &[u8], key: &[u8; 32]) -> Vec<u8> {
    hmac_sha256(key, &[index_json_bytes]).to_vec()
}

pub fn validate_index_mac(
    index_json_bytes: &[u8],
    expected_mac: &[u8],
    key: &[u8; 32],
) -> Result<(), AppStateError> {
    use subtle::ConstantTimeEq;
    if bool::from(hmac_sha256(key, &[index_json_bytes]).ct_eq(expected_mac)) {
        Ok(())
    } else {
        Err(AppStateError::MismatchingIndexMAC)
    }
}
