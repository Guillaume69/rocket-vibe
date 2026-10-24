//! Applying a snapshot or a patch: fold the integrity hash, check the MACs,
//! decode the records. Synchronous; keys and earlier value MACs come from
//! callbacks, so the caller owns storage.

use std::collections::HashMap;
use std::sync::Arc;

use log::{debug, log_enabled, warn};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use waproto::whatsapp as wa;

use crate::AppStateError;
use crate::decode::{Mutation, decode_record};
use crate::hash::{HashState, generate_patch_mac, operation, value_mac_tail};
use crate::keys::ExpandedAppStateKeys;

type Operation = wa::syncd_mutation::SyncdOperation;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppStateMutationMAC {
    pub index_mac: Vec<u8>,
    pub value_mac: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ProcessedSnapshot {
    pub state: HashState,
    pub mutations: Vec<Mutation>,
    /// The MACs to store, for the patches that will build on this snapshot.
    pub mutation_macs: Vec<AppStateMutationMAC>,
}

#[derive(Debug, Clone)]
pub struct PatchProcessingResult {
    pub state: HashState,
    pub mutations: Vec<Mutation>,
    pub added_macs: Vec<AppStateMutationMAC>,
    pub removed_index_macs: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PatchMacVerdict {
    /// The patch is authentic but its snapshot MAC disagrees with the hash.
    pub snapshot_mac_diverged: bool,
}

fn equal(a: &[u8], b: &[u8]) -> bool {
    a.ct_eq(b).into()
}

/// A snapshot replaces the collection: its version, its hash folded from
/// scratch onto `initial_state`, and every index's last record decoded. A
/// record without a value blob, or (when validating) a missing or wrong
/// snapshot MAC, refuses the whole snapshot.
pub fn process_snapshot<F>(
    snapshot: &wa::SyncdSnapshot,
    initial_state: &mut HashState,
    mut get_keys: F,
    validate_macs: bool,
    collection_name: &str,
) -> Result<ProcessedSnapshot, AppStateError>
where
    F: FnMut(&[u8]) -> Result<Arc<ExpandedAppStateKeys>, AppStateError>,
{
    let version = snapshot.version.version.unwrap_or(0);
    initial_state.version = version;
    let fold = initial_state.update_hash_from_records(&snapshot.records);
    if fold.valueless > 0 {
        warn!(target: "AppState", "snapshot {collection_name} v{version}: {} record(s) without a value", fold.valueless);
        return Err(AppStateError::MissingValueBlob);
    }
    if validate_macs {
        let mac = snapshot
            .mac
            .as_deref()
            .ok_or(AppStateError::SnapshotMACMissing)?;
        let key_id = snapshot
            .key_id
            .as_option()
            .and_then(|k| k.id.as_deref())
            .ok_or(AppStateError::SnapshotMACMissing)?;
        let keys = get_keys(key_id)?;
        if !equal(
            &initial_state.generate_snapshot_mac(collection_name, &keys.snapshot_mac),
            mac,
        ) {
            warn!(
                target: "AppState",
                "snapshot {collection_name} v{version}: MAC mismatch over {} records ({} folded, {} without index)",
                snapshot.records.len(),
                fold.folded,
                fold.unkeyed
            );
            return Err(AppStateError::SnapshotMACMismatch);
        }
    }
    let mut mutations = Vec::new();
    let mut mutation_macs = Vec::new();
    for record in last_record_per_index(&snapshot.records) {
        let key_id = record
            .key_id
            .id
            .as_deref()
            .ok_or(AppStateError::MissingKeyId)?;
        let keys = get_keys(key_id)?;
        let (mutation, macs) = decode_record(Operation::SET, record, &keys, key_id, validate_macs)?;
        mutation_macs.push(AppStateMutationMAC {
            index_mac: macs.index_mac,
            value_mac: macs.value_mac.to_vec(),
        });
        mutations.push(mutation);
    }
    summarize(collection_name, version, &mutations);
    Ok(ProcessedSnapshot {
        state: initial_state.clone(),
        mutations,
        mutation_macs,
    })
}

/// The records that count, in order: each index's last one, records without
/// a value left out, records without an index sharing the empty one.
fn last_record_per_index(records: &[wa::SyncdRecord]) -> Vec<&wa::SyncdRecord> {
    let mut last: HashMap<&[u8], usize> = HashMap::new();
    for (at, record) in records.iter().enumerate() {
        if record.value.blob.is_some() {
            last.insert(
                record
                    .index
                    .as_option()
                    .and_then(|i| i.blob.as_deref())
                    .unwrap_or_default(),
                at,
            );
        }
    }
    let mut winners: Vec<usize> = last.into_values().collect();
    winners.sort_unstable();
    winners.into_iter().map(|at| &records[at]).collect()
}

/// A patch moves the collection one version forward. `get_prev_value_mac`
/// answers an index's stored value MAC. The first patch over an empty state
/// may carry any version; any other must be exactly the next one.
pub fn process_patch<F, G>(
    patch: &wa::SyncdPatch,
    state: &mut HashState,
    mut get_keys: F,
    mut get_prev_value_mac: G,
    validate_macs: bool,
    collection_name: &str,
) -> Result<PatchProcessingResult, AppStateError>
where
    F: FnMut(&[u8]) -> Result<Arc<ExpandedAppStateKeys>, AppStateError>,
    G: FnMut(&[u8]) -> Result<Option<Vec<u8>>, AppStateError>,
{
    let had_no_prior_state = state.version == 0 && state.hash == [0u8; 128];
    let version = patch.version.version.unwrap_or(0);
    let expected = state.version.saturating_add(1);
    if !had_no_prior_state && version != expected {
        return Err(AppStateError::PatchVersionMismatch {
            expected,
            got: version,
        });
    }
    for m in &patch.mutations {
        operation(m)?;
    }
    state.version = version;

    // A SET earlier in this patch is the previous value of a later SET.
    let mut set_here: HashMap<&[u8], &[u8]> = HashMap::new();
    let (update, folded) = state.update_hash(&patch.mutations, |index_mac, i| {
        let mutation = &patch.mutations[i];
        let remove = mutation.operation.is_some_and(|op| op == Operation::REMOVE);
        let previous = match set_here.get(index_mac) {
            Some(mac) if !remove => Some(mac.to_vec()),
            _ => get_prev_value_mac(index_mac).map_err(anyhow::Error::from)?,
        };
        if !remove
            && let Some(record) = mutation.record.as_option()
            && let Some(index) = record.index.as_option().and_then(|i| i.blob.as_deref())
            && let Some(value) = record.value.as_option().and_then(|v| v.blob.as_deref())
        {
            set_here.insert(index, value_mac_tail(value));
        }
        Ok(previous)
    });
    folded.map_err(|_| AppStateError::MismatchingLTHash)?;

    if validate_macs && let Some(key_id) = patch.key_id.id.as_deref() {
        let keys = get_keys(key_id)?;
        let verdict = validate_patch_macs(
            patch,
            state,
            &keys,
            collection_name,
            had_no_prior_state,
            update.has_missing_remove,
        )?;
        if verdict.snapshot_mac_diverged && !state.mac_mismatch_fatal {
            warn!(
                target: "AppState",
                "{collection_name} diverged at v{}: authentic patch, snapshot MAC unreachable; no longer compared",
                state.version
            );
            state.mac_mismatch_fatal = true;
        }
    }
    if validate_macs {
        refuse_duplicate_index(&patch.mutations)?;
    }

    let mut mutations = Vec::new();
    let mut added_macs = Vec::new();
    let mut removed_index_macs = Vec::new();
    for m in patch.mutations.iter().filter(|m| m.record.is_set()) {
        let op = operation(m)?;
        let key_id = m
            .record
            .key_id
            .id
            .as_deref()
            .ok_or(AppStateError::MissingKeyId)?;
        let keys = get_keys(key_id)?;
        let (mutation, macs) = decode_record(op, &m.record, &keys, key_id, validate_macs)?;
        match op {
            Operation::REMOVE => removed_index_macs.push(macs.index_mac),
            _ => added_macs.push(AppStateMutationMAC {
                index_mac: macs.index_mac,
                value_mac: macs.value_mac.to_vec(),
            }),
        }
        mutations.push(mutation);
    }
    summarize(collection_name, state.version, &mutations);
    Ok(PatchProcessingResult {
        state: state.clone(),
        mutations,
        added_macs,
        removed_index_macs,
    })
}

/// The same index twice for the same operation in one patch.
fn refuse_duplicate_index(mutations: &[wa::SyncdMutation]) -> Result<(), AppStateError> {
    let (mut sets, mut removes): (Vec<&[u8]>, Vec<&[u8]>) = (Vec::new(), Vec::new());
    for m in mutations {
        let Some(index) = m
            .record
            .as_option()
            .and_then(|r| r.index.as_option())
            .and_then(|i| i.blob.as_deref())
        else {
            continue;
        };
        let seen = if operation(m)? == Operation::REMOVE {
            &mut removes
        } else {
            &mut sets
        };
        if seen.contains(&index) {
            return Err(AppStateError::DuplicateIndexInPatch);
        }
        seen.push(index);
    }
    Ok(())
}

/// The patch MAC proves authorship and is always required when present (and
/// on a first patch, where it must be). The snapshot MAC is compared only
/// while the collection has not diverged; a mismatch is reported, not
/// refused, as WhatsApp Web applies the patch and stops comparing.
pub fn validate_patch_macs(
    patch: &wa::SyncdPatch,
    state: &HashState,
    keys: &ExpandedAppStateKeys,
    collection_name: &str,
    had_no_prior_state: bool,
    has_missing_remove: bool,
) -> Result<PatchMacVerdict, AppStateError> {
    match patch.patch_mac.as_deref() {
        Some(mac) => {
            let version = patch.version.version.unwrap_or(0);
            if !equal(
                &generate_patch_mac(patch, collection_name, &keys.patch_mac, version),
                mac,
            ) {
                debug!(target: "AppState", "{collection_name} v{}: patch MAC mismatch (missing remove: {has_missing_remove})", state.version);
                return Err(AppStateError::PatchMACMismatch);
            }
        }
        None if had_no_prior_state => return Err(AppStateError::PatchMACMismatch),
        None => {}
    }
    if state.mac_mismatch_fatal {
        return Ok(PatchMacVerdict::default());
    }
    match patch.snapshot_mac.as_deref() {
        Some(mac) => Ok(PatchMacVerdict {
            snapshot_mac_diverged: !equal(
                &state.generate_snapshot_mac(collection_name, &keys.snapshot_mac),
                mac,
            ),
        }),
        None if had_no_prior_state => Err(AppStateError::PatchSnapshotMACMismatch),
        None => Ok(PatchMacVerdict::default()),
    }
}

pub fn validate_snapshot_mac(
    snapshot: &wa::SyncdSnapshot,
    state: &HashState,
    keys: &ExpandedAppStateKeys,
    collection_name: &str,
) -> Result<(), AppStateError> {
    let mac = snapshot
        .mac
        .as_deref()
        .ok_or(AppStateError::SnapshotMACMissing)?;
    if equal(
        &state.generate_snapshot_mac(collection_name, &keys.snapshot_mac),
        mac,
    ) {
        Ok(())
    } else {
        Err(AppStateError::SnapshotMACMismatch)
    }
}

/// One debug line of what arrived: operation and action name, counted. Only
/// declared action names are printed, never anything else from the wire.
fn summarize(collection_name: &str, version: u64, mutations: &[Mutation]) {
    if !log_enabled!(target: "AppState", log::Level::Debug) {
        return;
    }
    let mut counts: Vec<(String, usize)> = Vec::new();
    for m in mutations {
        let verb = match m.index.first().map(String::as_str) {
            None | Some("") => "<no-command>",
            Some(v) if known_command(v) => v,
            Some(_) => "<unknown-command>",
        };
        let op = if m.operation == Operation::REMOVE {
            "REMOVE"
        } else {
            "SET"
        };
        let key = format!("{op} {verb}");
        match counts.iter_mut().find(|(k, _)| *k == key) {
            Some((_, n)) => *n += 1,
            None => counts.push((key, 1)),
        }
    }
    counts.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    let line: Vec<String> = counts
        .iter()
        .take(12)
        .map(|(k, n)| format!("{k}×{n}"))
        .collect();
    debug!(target: "AppState", "decoded {collection_name} v{version}: {} mutations [{}]", mutations.len(), line.join(", "));
}

fn known_command(verb: &str) -> bool {
    verb == crate::schemas_unlisted::LABEL_MESSAGE.name
        || matches!(verb, "pin" | "mark_chat_as_read")
        || crate::schemas::is_known_wire_name(verb)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::encode_record;
    use crate::hash::generate_content_mac;
    use crate::keys::expand_app_state_keys;

    const NAME: &str = "regular";
    const KEY_ID: &[u8] = b"key-1";

    fn keys() -> Arc<ExpandedAppStateKeys> {
        Arc::new(expand_app_state_keys(&[9; 32]))
    }

    fn timestamped(ts: i64) -> wa::SyncActionValue {
        let mut value = wa::SyncActionValue::default();
        value.timestamp = Some(ts);
        value
    }

    fn mutation(op: Operation, index: &[&str], ts: i64, iv: u8) -> (wa::SyncdMutation, [u8; 32]) {
        let index = serde_json::to_vec(index).unwrap();
        encode_record(op, &index, &timestamped(ts), &keys(), KEY_ID, &[iv; 16], 1)
    }

    /// A patch as the server would send it over `state`: snapshot MAC of the
    /// state after it, patch MAC over everything.
    fn patch(
        state: &HashState,
        mutations: Vec<wa::SyncdMutation>,
        prev: &HashMap<Vec<u8>, Vec<u8>>,
    ) -> wa::SyncdPatch {
        let mut after = state.clone();
        let version = state.version + 1;
        after.version = version;
        let (_, folded) = after.update_hash(&mutations, |index, _| Ok(prev.get(index).cloned()));
        folded.unwrap();
        let mut p = wa::SyncdPatch::default();
        p.version = buffa::MessageField::some({
            let mut v = wa::SyncdVersion::default();
            v.version = Some(version);
            v
        });
        p.mutations = mutations;
        p.snapshot_mac = Some(after.generate_snapshot_mac(NAME, &keys().snapshot_mac));
        p.key_id = buffa::MessageField::some({
            let mut k = wa::KeyId::default();
            k.id = Some(KEY_ID.to_vec());
            k
        });
        p.patch_mac = Some(generate_patch_mac(&p, NAME, &keys().patch_mac, version));
        p
    }

    fn apply(
        state: &mut HashState,
        p: &wa::SyncdPatch,
        prev: &HashMap<Vec<u8>, Vec<u8>>,
    ) -> Result<PatchProcessingResult, AppStateError> {
        process_patch(
            p,
            state,
            |_| Ok(keys()),
            |index| Ok(prev.get(index).cloned()),
            true,
            NAME,
        )
    }

    #[test]
    fn a_patch_round_trips_and_its_macs_verify() {
        let mut state = HashState {
            version: 4,
            hash: [1; 128],
            ..HashState::default()
        };
        let (set, _) = mutation(Operation::SET, &["archive", "123@s.whatsapp.net"], 77, 1);
        let p = patch(&state, vec![set], &HashMap::new());
        let out = apply(&mut state, &p, &HashMap::new()).unwrap();
        assert_eq!(out.state.version, 5);
        assert!(!out.state.mac_mismatch_fatal);
        assert_eq!(out.mutations[0].index, ["archive", "123@s.whatsapp.net"]);
        assert_eq!(
            out.mutations[0].action_value.as_ref().unwrap().timestamp,
            Some(77)
        );
        assert_eq!(out.added_macs.len(), 1);
    }

    #[test]
    fn a_patch_out_of_sequence_is_refused() {
        let mut state = HashState {
            version: 4,
            hash: [1; 128],
            ..HashState::default()
        };
        let (set, _) = mutation(Operation::SET, &["mute", "a"], 1, 1);
        let mut p = patch(&state, vec![set], &HashMap::new());
        p.version.as_option_mut().unwrap().version = Some(7);
        assert!(matches!(
            apply(&mut state, &p, &HashMap::new()),
            Err(AppStateError::PatchVersionMismatch {
                expected: 5,
                got: 7
            })
        ));
    }

    #[test]
    fn a_forged_patch_mac_is_refused_and_a_diverged_hash_only_flagged() {
        let base = HashState {
            version: 2,
            hash: [5; 128],
            ..HashState::default()
        };
        let (set, _) = mutation(Operation::SET, &["pin_v1", "b"], 1, 2);
        let mut forged = patch(&base, vec![set.clone()], &HashMap::new());
        forged.patch_mac.as_mut().unwrap()[0] ^= 1;
        assert!(matches!(
            apply(&mut base.clone(), &forged, &HashMap::new()),
            Err(AppStateError::PatchMACMismatch)
        ));

        let mut diverged = patch(&base, vec![set], &HashMap::new());
        diverged.snapshot_mac.as_mut().unwrap()[0] ^= 1;
        diverged.patch_mac = Some(generate_patch_mac(&diverged, NAME, &keys().patch_mac, 3));
        let out = apply(&mut base.clone(), &diverged, &HashMap::new()).unwrap();
        assert!(out.state.mac_mismatch_fatal);
    }

    #[test]
    fn a_remove_subtracts_the_value_it_replaces() {
        let mut state = HashState {
            version: 1,
            hash: [0; 128],
            bootstrapped: true,
            ..HashState::default()
        };
        let (set, set_mac) = mutation(Operation::SET, &["star", "c"], 1, 3);
        let index_mac = set.record.index.blob.clone().unwrap();
        let p = patch(&state, vec![set], &HashMap::new());
        apply(&mut state, &p, &HashMap::new()).unwrap();
        let mut stored = HashMap::new();
        stored.insert(index_mac.clone(), set_mac.to_vec());
        let (remove, _) = mutation(Operation::REMOVE, &["star", "c"], 2, 4);
        assert_eq!(
            remove.record.index.blob.as_deref(),
            Some(index_mac.as_slice())
        );
        let p = patch(&state, vec![remove], &stored);
        let out = apply(&mut state, &p, &stored).unwrap();
        assert_eq!(out.removed_index_macs, vec![index_mac]);
        assert_eq!(
            out.state.hash, [0u8; 128],
            "SET then REMOVE leaves the hash where it started"
        );
    }

    #[test]
    fn the_same_index_twice_in_one_patch_is_refused() {
        let mut state = HashState {
            version: 1,
            hash: [2; 128],
            ..HashState::default()
        };
        let (a, _) = mutation(Operation::SET, &["mute", "d"], 1, 5);
        let (b, _) = mutation(Operation::SET, &["mute", "d"], 2, 6);
        let p = patch(&state, vec![a, b], &HashMap::new());
        assert!(matches!(
            apply(&mut state, &p, &HashMap::new()),
            Err(AppStateError::DuplicateIndexInPatch)
        ));
    }

    #[test]
    fn a_tampered_record_is_refused() {
        let (mut set, _) = mutation(Operation::SET, &["archive", "e"], 1, 7);
        let blob = set
            .record
            .as_option_mut()
            .unwrap()
            .value
            .as_option_mut()
            .unwrap()
            .blob
            .as_mut()
            .unwrap();
        blob[20] ^= 1;
        let record = set.record.as_option().unwrap();
        assert!(matches!(
            decode_record(Operation::SET, record, &keys(), KEY_ID, true),
            Err(AppStateError::MismatchingContentMAC)
        ));
    }

    #[test]
    fn a_snapshot_keeps_each_index_last_record() {
        let (first, _) = mutation(Operation::SET, &["archive", "f"], 1, 8);
        let (second, _) = mutation(Operation::SET, &["archive", "f"], 2, 9);
        let (other, _) = mutation(Operation::SET, &["mute", "g"], 3, 10);
        let records: Vec<wa::SyncdRecord> = [first, second.clone(), other.clone()]
            .into_iter()
            .map(|m| m.record.as_option().unwrap().clone())
            .collect();
        let mut expected = HashState::default();
        let only_winners: Vec<wa::SyncdRecord> = [second, other]
            .into_iter()
            .map(|m| m.record.as_option().unwrap().clone())
            .collect();
        let report = expected.update_hash_from_records(&only_winners);
        assert_eq!(report.folded, 2);
        expected.version = 9;
        let mut snapshot = wa::SyncdSnapshot::default();
        snapshot.version = buffa::MessageField::some({
            let mut v = wa::SyncdVersion::default();
            v.version = Some(9);
            v
        });
        snapshot.records = records;
        snapshot.mac = Some(expected.generate_snapshot_mac(NAME, &keys().snapshot_mac));
        snapshot.key_id = buffa::MessageField::some({
            let mut k = wa::KeyId::default();
            k.id = Some(KEY_ID.to_vec());
            k
        });
        let out = process_snapshot(
            &snapshot,
            &mut HashState::default(),
            |_| Ok(keys()),
            true,
            NAME,
        )
        .unwrap();
        assert_eq!(out.state.hash, expected.hash);
        assert_eq!(out.mutations.len(), 2);
        assert_eq!(
            out.mutations[0].action_value.as_ref().unwrap().timestamp,
            Some(2)
        );
    }

    #[test]
    fn content_mac_depends_on_the_operation() {
        let k = keys();
        assert_ne!(
            generate_content_mac(Operation::SET, b"x", KEY_ID, &k.value_mac),
            generate_content_mac(Operation::REMOVE, b"x", KEY_ID, &k.value_mac)
        );
    }

    #[test]
    fn a_short_blob_folds_from_twice_its_length_minus_32() {
        assert_eq!(value_mac_tail(&[1; 40]).len(), 32);
        assert_eq!(value_mac_tail(&[1; 31]), &[1][..]);
        assert_eq!(value_mac_tail(&[1; 16]).len(), 16);
    }
}
