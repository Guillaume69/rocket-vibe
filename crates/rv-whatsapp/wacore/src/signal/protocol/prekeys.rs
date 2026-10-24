//! One-time and signed prekeys, stored as WhatsApp's `PreKeyRecordStructure`
//! and `SignedPreKeyRecordStructure` with raw 32-byte public keys.

use std::fmt;

use waproto::codec;
use waproto::whatsapp as wa;

use super::error::{Result, SignalProtocolError};
use super::keys::{KeyPair, PrivateKey, PublicKey};

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub struct PreKeyId(u32);

impl From<u32> for PreKeyId {
    fn from(id: u32) -> Self {
        Self(id)
    }
}

impl From<PreKeyId> for u32 {
    fn from(id: PreKeyId) -> Self {
        id.0
    }
}

impl fmt::Display for PreKeyId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub struct SignedPreKeyId(u32);

impl From<u32> for SignedPreKeyId {
    fn from(id: u32) -> Self {
        Self(id)
    }
}

impl From<SignedPreKeyId> for u32 {
    fn from(id: SignedPreKeyId) -> Self {
        id.0
    }
}

impl fmt::Display for SignedPreKeyId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Milliseconds since the epoch.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, Default)]
pub struct Timestamp(u64);

impl Timestamp {
    pub const fn from_epoch_millis(milliseconds: u64) -> Self {
        Self(milliseconds)
    }
    pub const fn epoch_millis(self) -> u64 {
        self.0
    }
}

fn key_pair_from(public: Option<&[u8]>, private: Option<&[u8]>) -> Result<KeyPair> {
    let public = public.ok_or(SignalProtocolError::InvalidProtobufEncoding)?;
    let private = private.ok_or(SignalProtocolError::InvalidProtobufEncoding)?;
    let public = if public.len() == 33 {
        PublicKey::deserialize(public)?
    } else {
        let raw: [u8; 32] = public
            .try_into()
            .map_err(|_| SignalProtocolError::BadKeyLength(public.len()))?;
        PublicKey::from_raw(raw)
    };
    Ok(KeyPair {
        public,
        private: PrivateKey::deserialize(private)?,
    })
}

#[derive(Clone, Debug)]
pub struct PreKeyRecord(wa::PreKeyRecordStructure);

impl PreKeyRecord {
    pub fn new(id: PreKeyId, key: &KeyPair) -> Self {
        let mut s = wa::PreKeyRecordStructure::default();
        s.id = Some(id.0);
        s.public_key = Some(key.public.raw().to_vec());
        s.private_key = Some(key.private.serialize().to_vec());
        Self(s)
    }

    pub(crate) fn from_structure(structure: wa::PreKeyRecordStructure) -> Self {
        Self(structure)
    }

    pub(crate) fn structure(&self) -> &wa::PreKeyRecordStructure {
        &self.0
    }

    pub fn deserialize(data: &[u8]) -> Result<Self> {
        Ok(Self(codec::pre_key_record_decode(data).map_err(|_| {
            SignalProtocolError::InvalidProtobufEncoding
        })?))
    }

    pub fn serialize(&self) -> Result<Vec<u8>> {
        Ok(codec::pre_key_record_to_vec(&self.0))
    }

    pub fn id(&self) -> Result<PreKeyId> {
        self.0
            .id
            .map(PreKeyId)
            .ok_or(SignalProtocolError::InvalidProtobufEncoding)
    }

    pub fn key_pair(&self) -> Result<KeyPair> {
        key_pair_from(self.0.public_key.as_deref(), self.0.private_key.as_deref())
    }

    pub fn public_key(&self) -> Result<PublicKey> {
        Ok(self.key_pair()?.public)
    }

    pub fn private_key(&self) -> Result<PrivateKey> {
        Ok(self.key_pair()?.private)
    }
}

/// A signed prekey record's operations, as a trait the engine imports.
pub trait GenericSignedPreKey {
    fn new(id: SignedPreKeyId, timestamp: Timestamp, key_pair: &KeyPair, signature: &[u8]) -> Self
    where
        Self: Sized;
    fn deserialize(data: &[u8]) -> Result<Self>
    where
        Self: Sized;
    fn from_storage(storage: wa::SignedPreKeyRecordStructure) -> Self
    where
        Self: Sized;
    fn from_stored_structure(storage: wa::SignedPreKeyRecordStructure) -> Self
    where
        Self: Sized;
    fn get_storage(&self) -> &wa::SignedPreKeyRecordStructure;
    fn id(&self) -> Result<SignedPreKeyId>;
    fn key_pair(&self) -> Result<KeyPair>;
    fn public_key(&self) -> Result<PublicKey>;
    fn serialize(&self) -> Result<Vec<u8>>;
    fn signature(&self) -> Result<Vec<u8>>;
    fn signature_bytes(&self) -> Result<&[u8]>;
    fn timestamp(&self) -> Result<Timestamp>;
}

#[derive(Clone, Debug)]
pub struct SignedPreKeyRecord(wa::SignedPreKeyRecordStructure);

impl SignedPreKeyRecord {
    pub fn private_key(&self) -> Result<PrivateKey> {
        Ok(self.key_pair()?.private)
    }
}

impl GenericSignedPreKey for SignedPreKeyRecord {
    fn new(id: SignedPreKeyId, timestamp: Timestamp, key_pair: &KeyPair, signature: &[u8]) -> Self {
        let mut s = wa::SignedPreKeyRecordStructure::default();
        s.id = Some(id.0);
        s.public_key = Some(key_pair.public.raw().to_vec());
        s.private_key = Some(key_pair.private.serialize().to_vec());
        s.signature = Some(signature.to_vec());
        s.timestamp = Some(timestamp.0);
        Self(s)
    }

    fn deserialize(data: &[u8]) -> Result<Self> {
        Ok(Self(codec::signed_pre_key_record_decode(data).map_err(
            |_| SignalProtocolError::InvalidProtobufEncoding,
        )?))
    }

    fn from_storage(storage: wa::SignedPreKeyRecordStructure) -> Self {
        Self(storage)
    }

    fn from_stored_structure(storage: wa::SignedPreKeyRecordStructure) -> Self {
        Self(storage)
    }

    fn get_storage(&self) -> &wa::SignedPreKeyRecordStructure {
        &self.0
    }

    fn id(&self) -> Result<SignedPreKeyId> {
        self.0
            .id
            .map(SignedPreKeyId)
            .ok_or(SignalProtocolError::InvalidProtobufEncoding)
    }

    fn key_pair(&self) -> Result<KeyPair> {
        key_pair_from(self.0.public_key.as_deref(), self.0.private_key.as_deref())
    }

    fn public_key(&self) -> Result<PublicKey> {
        Ok(self.key_pair()?.public)
    }

    fn serialize(&self) -> Result<Vec<u8>> {
        Ok(codec::signed_pre_key_record_to_vec(&self.0))
    }

    fn signature(&self) -> Result<Vec<u8>> {
        Ok(self.signature_bytes()?.to_vec())
    }

    fn signature_bytes(&self) -> Result<&[u8]> {
        self.0
            .signature
            .as_deref()
            .ok_or(SignalProtocolError::InvalidProtobufEncoding)
    }

    fn timestamp(&self) -> Result<Timestamp> {
        Ok(Timestamp(self.0.timestamp.unwrap_or(0)))
    }
}
