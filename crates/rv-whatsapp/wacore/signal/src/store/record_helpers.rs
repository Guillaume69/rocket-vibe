//! Prekey records as stored: raw 32-byte public keys.

use chrono::{DateTime, Utc};
use waproto::whatsapp as wa;

use crate::protocol::{
    GenericSignedPreKey, KeyPair, PreKeyRecord, SignalProtocolError, SignedPreKeyRecord,
};

pub fn new_pre_key_record(id: u32, key_pair: &KeyPair) -> wa::PreKeyRecordStructure {
    let mut s = wa::PreKeyRecordStructure::default();
    s.id = Some(id);
    s.public_key = Some(key_pair.public.raw().to_vec());
    s.private_key = Some(key_pair.private.serialize().to_vec());
    s
}

/// Appends the encoded record to `out`.
pub fn encode_pre_key_record_to(id: u32, key_pair: &KeyPair, out: &mut Vec<u8>) {
    waproto::codec::pre_key_record_encode_into(&new_pre_key_record(id, key_pair), out);
}

pub fn new_signed_pre_key_record(
    id: u32,
    key_pair: &KeyPair,
    signature: [u8; 64],
    timestamp: DateTime<Utc>,
) -> wa::SignedPreKeyRecordStructure {
    let mut s = wa::SignedPreKeyRecordStructure::default();
    s.id = Some(id);
    s.public_key = Some(key_pair.public.raw().to_vec());
    s.private_key = Some(key_pair.private.serialize().to_vec());
    s.signature = Some(signature.to_vec());
    s.timestamp = Some(timestamp.timestamp_millis().max(0) as u64);
    s
}

pub fn prekey_structure_to_record(
    structure: wa::PreKeyRecordStructure,
) -> Result<PreKeyRecord, SignalProtocolError> {
    let record = PreKeyRecord::from_structure(structure);
    record.key_pair()?;
    Ok(record)
}

pub fn prekey_record_to_structure(
    record: &PreKeyRecord,
) -> Result<wa::PreKeyRecordStructure, SignalProtocolError> {
    Ok(record.structure().clone())
}

pub fn signed_prekey_structure_to_record(
    structure: wa::SignedPreKeyRecordStructure,
) -> Result<SignedPreKeyRecord, SignalProtocolError> {
    let record = SignedPreKeyRecord::from_storage(structure);
    record.key_pair()?;
    Ok(record)
}
