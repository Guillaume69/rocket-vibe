//! One record: `value.blob` is IV (16) || AES-256-CBC(`SyncActionData`) ||
//! value MAC (32), `index.blob` the HMAC of the action's JSON index.

use subtle::ConstantTimeEq;
use waproto::whatsapp as wa;

use crate::AppStateError;
use crate::crypto::aes_cbc_decrypt;
use crate::hash::{generate_content_mac, validate_index_mac};
use crate::keys::ExpandedAppStateKeys;

/// A decoded mutation.
#[derive(Debug, Clone)]
pub struct Mutation {
    pub action_value: Option<wa::SyncActionValue>,
    /// The index, a JSON array of strings: the action name, then its keys.
    pub index: Vec<String>,
    pub operation: wa::syncd_mutation::SyncdOperation,
}

/// A record's MACs, kept apart from the mutation for the MAC store.
#[derive(Debug, Clone)]
pub struct RecordMacs {
    pub index_mac: Vec<u8>,
    pub value_mac: [u8; 32],
}

pub fn decode_record(
    operation: wa::syncd_mutation::SyncdOperation,
    record: &wa::SyncdRecord,
    keys: &ExpandedAppStateKeys,
    key_id: &[u8],
    validate_macs: bool,
) -> Result<(Mutation, RecordMacs), AppStateError> {
    let blob = record
        .value
        .blob
        .as_deref()
        .ok_or(AppStateError::MissingValueBlob)?;
    if blob.len() < 16 + 32 {
        return Err(AppStateError::ValueBlobTooShort);
    }
    let (sealed, value_mac) = blob.split_at(blob.len() - 32);
    if validate_macs {
        let expected = generate_content_mac(operation, sealed, key_id, &keys.value_mac);
        if !bool::from(expected.ct_eq(value_mac)) {
            return Err(AppStateError::MismatchingContentMAC);
        }
    }
    let (iv, ciphertext) = sealed.split_at(16);
    let plaintext = aes_cbc_decrypt(&keys.value_encryption, iv, ciphertext)
        .ok_or(AppStateError::DecryptionFailed)?;
    let action = waproto::codec::sync_action_data_decode(plaintext.as_slice())
        .map_err(|_| AppStateError::DecodeFailed)?;
    let index_mac = record
        .index
        .as_option()
        .and_then(|i| i.blob.clone())
        .ok_or(AppStateError::MissingIndexMAC)?;
    // WhatsApp Web checks the index MAC even over an absent index (an empty one).
    if validate_macs {
        validate_index_mac(
            action.index.as_deref().unwrap_or_default(),
            &index_mac,
            &keys.index,
        )?;
    }
    let index = action
        .index
        .as_deref()
        .and_then(|bytes| serde_json::from_slice::<Vec<String>>(bytes).ok())
        .unwrap_or_default();
    Ok((
        Mutation {
            action_value: action.value.into_option(),
            index,
            operation,
        },
        RecordMacs {
            index_mac,
            value_mac: value_mac.try_into().expect("32 bytes"),
        },
    ))
}

/// The key ids a snapshot and its patches need, each once, in order of first use.
pub fn collect_key_id_refs_from_patch_list<'a>(
    snapshot: Option<&'a wa::SyncdSnapshot>,
    patches: &'a [wa::SyncdPatch],
) -> Vec<&'a [u8]> {
    let mut ids: Vec<&'a [u8]> = Vec::new();
    let mut push = |id: Option<&'a Vec<u8>>| {
        if let Some(id) = id.map(Vec::as_slice)
            && !ids.contains(&id)
        {
            ids.push(id);
        }
    };
    if let Some(snapshot) = snapshot {
        push(snapshot.key_id.id.as_ref());
        for record in &snapshot.records {
            push(record.key_id.id.as_ref());
        }
    }
    for patch in patches {
        push(patch.key_id.id.as_ref());
        for mutation in &patch.mutations {
            if mutation.record.is_set() {
                push(mutation.record.key_id.id.as_ref());
            }
        }
    }
    ids
}

pub fn collect_key_ids_from_patch_list(
    snapshot: Option<&wa::SyncdSnapshot>,
    patches: &[wa::SyncdPatch],
) -> Vec<Vec<u8>> {
    collect_key_id_refs_from_patch_list(snapshot, patches)
        .into_iter()
        .map(<[u8]>::to_vec)
        .collect()
}
