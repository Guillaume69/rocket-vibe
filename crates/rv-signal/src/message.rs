//! The wire messages: a version byte (message version in the high nibble,
//! current version in the low one), the protobuf of `WAProto.proto`, then a
//! truncated MAC (`SignalMessage`) or a signature (`SenderKeyMessage`).

use rand_core::CryptoRng;
use subtle::ConstantTimeEq;

use crate::crypto::hmac_sha256;
use crate::curve::{PrivateKey, PublicKey};
use crate::proto::{Writer, fields};
use crate::{Error, Result};

pub const VERSION: u8 = 3;
const VERSION_BYTE: u8 = (VERSION << 4) | VERSION;
pub(crate) const MAC_LENGTH: usize = 8;

/// How a WhatsApp `<enc>` node names each kind: `msg`, `pkmsg`, `skmsg`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Whisper,
    PreKey,
    SenderKey,
}

impl Kind {
    pub fn wire_name(self) -> &'static str {
        match self {
            Kind::Whisper => "msg",
            Kind::PreKey => "pkmsg",
            Kind::SenderKey => "skmsg",
        }
    }

    pub fn from_wire_name(name: &str) -> Option<Self> {
        match name {
            "msg" => Some(Kind::Whisper),
            "pkmsg" => Some(Kind::PreKey),
            "skmsg" => Some(Kind::SenderKey),
            _ => None,
        }
    }
}

fn check_version(byte: u8) -> Result<()> {
    match byte >> 4 {
        VERSION => Ok(()),
        other => Err(Error::UnsupportedVersion(other)),
    }
}

fn split_version(bytes: &[u8]) -> Result<(u8, &[u8])> {
    let (&version, body) = bytes
        .split_first()
        .ok_or(Error::InvalidMessage("empty message"))?;
    check_version(version)?;
    Ok((version, body))
}

#[derive(Clone, Debug)]
pub struct SignalMessage {
    pub ratchet_key: PublicKey,
    pub counter: u32,
    pub previous_counter: u32,
    pub ciphertext: Vec<u8>,
    serialized: Vec<u8>,
}

fn mac(mac_key: &[u8], sender: &PublicKey, receiver: &PublicKey, body: &[u8]) -> [u8; MAC_LENGTH] {
    let full = hmac_sha256(mac_key, &[&sender.serialize(), &receiver.serialize(), body]);
    full[..MAC_LENGTH].try_into().expect("MAC length")
}

impl SignalMessage {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        mac_key: &[u8],
        sender_identity: &PublicKey,
        receiver_identity: &PublicKey,
        ratchet_key: PublicKey,
        counter: u32,
        previous_counter: u32,
        ciphertext: Vec<u8>,
    ) -> Self {
        let mut w = Writer(vec![VERSION_BYTE]);
        w.bytes(1, &ratchet_key.serialize());
        w.uint(2, counter.into());
        w.uint(3, previous_counter.into());
        w.bytes(4, &ciphertext);
        let tag = mac(mac_key, sender_identity, receiver_identity, &w.0);
        w.0.extend_from_slice(&tag);
        Self {
            ratchet_key,
            counter,
            previous_counter,
            ciphertext,
            serialized: w.0,
        }
    }

    pub fn deserialize(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 1 + MAC_LENGTH {
            return Err(Error::InvalidMessage("signal message too short"));
        }
        let (_, body) = split_version(&bytes[..bytes.len() - MAC_LENGTH])?;
        let (mut ratchet_key, mut counter, mut previous_counter, mut ciphertext) =
            (None, None, 0, None);
        fields(body, |field, value| {
            match field {
                1 => ratchet_key = Some(PublicKey::deserialize(value.bytes()?)?),
                2 => counter = Some(value.u32()?),
                3 => previous_counter = value.u32()?,
                4 => ciphertext = Some(value.bytes()?.to_vec()),
                _ => {}
            }
            Ok(())
        })?;
        Ok(Self {
            ratchet_key: ratchet_key.ok_or(Error::InvalidMessage("no ratchet key"))?,
            counter: counter.ok_or(Error::InvalidMessage("no counter"))?,
            previous_counter,
            ciphertext: ciphertext.ok_or(Error::InvalidMessage("no ciphertext"))?,
            serialized: bytes.to_vec(),
        })
    }

    pub fn verify_mac(
        &self,
        sender_identity: &PublicKey,
        receiver_identity: &PublicKey,
        mac_key: &[u8],
    ) -> bool {
        let (body, tag) = self.serialized.split_at(self.serialized.len() - MAC_LENGTH);
        mac(mac_key, sender_identity, receiver_identity, body)
            .ct_eq(tag)
            .into()
    }

    pub fn serialized(&self) -> &[u8] {
        &self.serialized
    }
}

#[derive(Clone, Debug)]
pub struct PreKeySignalMessage {
    pub registration_id: u32,
    pub prekey_id: Option<u32>,
    pub signed_prekey_id: u32,
    pub base_key: PublicKey,
    pub identity_key: PublicKey,
    pub message: SignalMessage,
    serialized: Vec<u8>,
}

impl PreKeySignalMessage {
    pub fn new(
        registration_id: u32,
        prekey_id: Option<u32>,
        signed_prekey_id: u32,
        base_key: PublicKey,
        identity_key: PublicKey,
        message: SignalMessage,
    ) -> Self {
        let mut w = Writer(vec![VERSION_BYTE]);
        w.opt_uint(1, prekey_id.map(u64::from));
        w.bytes(2, &base_key.serialize());
        w.bytes(3, &identity_key.serialize());
        w.bytes(4, message.serialized());
        w.uint(5, registration_id.into());
        w.uint(6, signed_prekey_id.into());
        Self {
            registration_id,
            prekey_id,
            signed_prekey_id,
            base_key,
            identity_key,
            message,
            serialized: w.0,
        }
    }

    pub fn deserialize(bytes: &[u8]) -> Result<Self> {
        let (_, body) = split_version(bytes)?;
        let (mut registration_id, mut prekey_id, mut signed_prekey_id) = (0, None, None);
        let (mut base_key, mut identity_key, mut message) = (None, None, None);
        fields(body, |field, value| {
            match field {
                1 => prekey_id = Some(value.u32()?),
                2 => base_key = Some(PublicKey::deserialize(value.bytes()?)?),
                3 => identity_key = Some(PublicKey::deserialize(value.bytes()?)?),
                4 => message = Some(SignalMessage::deserialize(value.bytes()?)?),
                5 => registration_id = value.u32()?,
                6 => signed_prekey_id = Some(value.u32()?),
                _ => {}
            }
            Ok(())
        })?;
        Ok(Self {
            registration_id,
            prekey_id,
            signed_prekey_id: signed_prekey_id
                .ok_or(Error::InvalidMessage("no signed prekey id"))?,
            base_key: base_key.ok_or(Error::InvalidMessage("no base key"))?,
            identity_key: identity_key.ok_or(Error::InvalidMessage("no identity key"))?,
            message: message.ok_or(Error::InvalidMessage("no message"))?,
            serialized: bytes.to_vec(),
        })
    }

    pub fn serialized(&self) -> &[u8] {
        &self.serialized
    }
}

#[derive(Clone, Debug)]
pub struct SenderKeyDistributionMessage {
    pub chain_id: u32,
    pub iteration: u32,
    pub chain_key: [u8; 32],
    pub signing_key: PublicKey,
    serialized: Vec<u8>,
}

impl SenderKeyDistributionMessage {
    pub fn new(chain_id: u32, iteration: u32, chain_key: [u8; 32], signing_key: PublicKey) -> Self {
        let mut w = Writer(vec![VERSION_BYTE]);
        w.uint(1, chain_id.into());
        w.uint(2, iteration.into());
        w.bytes(3, &chain_key);
        w.bytes(4, &signing_key.serialize());
        Self {
            chain_id,
            iteration,
            chain_key,
            signing_key,
            serialized: w.0,
        }
    }

    pub fn deserialize(bytes: &[u8]) -> Result<Self> {
        let (_, body) = split_version(bytes)?;
        let (mut chain_id, mut iteration, mut chain_key, mut signing_key) = (None, 0, None, None);
        fields(body, |field, value| {
            match field {
                1 => chain_id = Some(value.u32()?),
                2 => iteration = value.u32()?,
                3 => {
                    chain_key = Some(
                        value
                            .bytes()?
                            .try_into()
                            .map_err(|_| Error::InvalidMessage("chain key"))?,
                    )
                }
                4 => signing_key = Some(PublicKey::deserialize(value.bytes()?)?),
                _ => {}
            }
            Ok(())
        })?;
        Ok(Self {
            chain_id: chain_id.ok_or(Error::InvalidMessage("no chain id"))?,
            iteration,
            chain_key: chain_key.ok_or(Error::InvalidMessage("no chain key"))?,
            signing_key: signing_key.ok_or(Error::InvalidMessage("no signing key"))?,
            serialized: bytes.to_vec(),
        })
    }

    pub fn serialized(&self) -> &[u8] {
        &self.serialized
    }
}

#[derive(Clone, Debug)]
pub struct SenderKeyMessage {
    pub chain_id: u32,
    pub iteration: u32,
    pub ciphertext: Vec<u8>,
    serialized: Vec<u8>,
}

const SIGNATURE_LENGTH: usize = 64;

impl SenderKeyMessage {
    pub fn new<R: CryptoRng + ?Sized>(
        chain_id: u32,
        iteration: u32,
        ciphertext: Vec<u8>,
        signing_key: &PrivateKey,
        rng: &mut R,
    ) -> Self {
        let mut w = Writer(vec![VERSION_BYTE]);
        w.uint(1, chain_id.into());
        w.uint(2, iteration.into());
        w.bytes(3, &ciphertext);
        let signature = signing_key.sign(&w.0, rng);
        w.0.extend_from_slice(&signature);
        Self {
            chain_id,
            iteration,
            ciphertext,
            serialized: w.0,
        }
    }

    pub fn deserialize(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 1 + SIGNATURE_LENGTH {
            return Err(Error::InvalidMessage("sender key message too short"));
        }
        let (_, body) = split_version(&bytes[..bytes.len() - SIGNATURE_LENGTH])?;
        let (mut chain_id, mut iteration, mut ciphertext) = (None, 0, None);
        fields(body, |field, value| {
            match field {
                1 => chain_id = Some(value.u32()?),
                2 => iteration = value.u32()?,
                3 => ciphertext = Some(value.bytes()?.to_vec()),
                _ => {}
            }
            Ok(())
        })?;
        Ok(Self {
            chain_id: chain_id.ok_or(Error::InvalidMessage("no chain id"))?,
            iteration,
            ciphertext: ciphertext.ok_or(Error::InvalidMessage("no ciphertext"))?,
            serialized: bytes.to_vec(),
        })
    }

    pub fn verify_signature(&self, signing_key: &PublicKey) -> bool {
        let (body, signature) = self
            .serialized
            .split_at(self.serialized.len() - SIGNATURE_LENGTH);
        signing_key.verify(body, signature.try_into().expect("signature length"))
    }

    pub fn serialized(&self) -> &[u8] {
        &self.serialized
    }
}
