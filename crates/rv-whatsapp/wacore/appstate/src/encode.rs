use waproto::whatsapp as wa;

use crate::crypto::{aes_cbc_encrypt, hmac_sha256};
use crate::hash::generate_content_mac;
use crate::keys::ExpandedAppStateKeys;

/// Seals one mutation: `SyncActionData` encrypted under `iv`, its value MAC
/// appended, the index MAC beside it. `version` is the action's own schema
/// version. Returns the mutation and its value MAC.
pub fn encode_record(
    operation: wa::syncd_mutation::SyncdOperation,
    index: &[u8],
    value: &wa::SyncActionValue,
    keys: &ExpandedAppStateKeys,
    key_id: &[u8],
    iv: &[u8; 16],
    version: i32,
) -> (wa::SyncdMutation, [u8; 32]) {
    let plaintext = waproto::codec::sync_action_data_to_vec(index, value, version);
    let mut blob = iv.to_vec();
    blob.extend(aes_cbc_encrypt(&keys.value_encryption, iv, &plaintext));
    let value_mac = generate_content_mac(operation, &blob, key_id, &keys.value_mac);
    blob.extend_from_slice(&value_mac);

    let mut record = wa::SyncdRecord::default();
    let mut index_field = wa::SyncdIndex::default();
    index_field.blob = Some(hmac_sha256(&keys.index, &[index]).to_vec());
    record.index = buffa::MessageField::some(index_field);
    let mut value_field = wa::SyncdValue::default();
    value_field.blob = Some(blob);
    record.value = buffa::MessageField::some(value_field);
    let mut key = wa::KeyId::default();
    key.id = Some(key_id.to_vec());
    record.key_id = buffa::MessageField::some(key);

    let mut mutation = wa::SyncdMutation::default();
    mutation.operation = Some(operation.into());
    mutation.record = buffa::MessageField::some(record);
    (mutation, value_mac)
}
