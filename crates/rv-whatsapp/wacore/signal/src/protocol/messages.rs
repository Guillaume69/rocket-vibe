//! The four message kinds, over `rv-signal`'s.

use bytes::Bytes;
use rand::CryptoRng;

use super::error::{Result, SignalProtocolError};
use super::keys::{IdentityKey, PrivateKey, PublicKey};
use super::prekeys::{PreKeyId, SignedPreKeyId};

pub const CIPHERTEXT_MESSAGE_CURRENT_VERSION: u8 = 3;
pub const SENDERKEY_MESSAGE_CURRENT_VERSION: u8 = 3;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[repr(u8)]
pub enum CiphertextMessageType {
    Whisper = 2,
    PreKey = 3,
    SenderKey = 7,
    Plaintext = 8,
}

impl TryFrom<u8> for CiphertextMessageType {
    type Error = SignalProtocolError;
    fn try_from(value: u8) -> Result<Self> {
        match value {
            2 => Ok(Self::Whisper),
            3 => Ok(Self::PreKey),
            7 => Ok(Self::SenderKey),
            8 => Ok(Self::Plaintext),
            other => Err(SignalProtocolError::InvalidArgument(format!(
                "unknown message type {other}"
            ))),
        }
    }
}

/// Versions a message may be built with: 3, WhatsApp's, and 4, which only
/// differs by the post-quantum fields WhatsApp does not send. Either goes on
/// the wire as 3.
fn check_version(version: u8) -> Result<()> {
    match version {
        v if v < 3 => Err(SignalProtocolError::LegacyCiphertextVersion(v)),
        3 | 4 => Ok(()),
        v => Err(SignalProtocolError::UnrecognizedMessageVersion(u32::from(
            v,
        ))),
    }
}

/// A `msg`.
#[derive(Clone, Debug)]
pub struct SignalMessage {
    pub(crate) inner: rv_signal::SignalMessage,
    ratchet_key: PublicKey,
}

impl SignalMessage {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        message_version: u8,
        mac_key: &[u8],
        sender_ratchet_key: PublicKey,
        counter: u32,
        previous_counter: u32,
        ciphertext: &[u8],
        sender_identity_key: &IdentityKey,
        receiver_identity_key: &IdentityKey,
    ) -> Result<Self> {
        check_version(message_version)?;
        let inner = rv_signal::SignalMessage::new(
            mac_key,
            sender_identity_key.public_key().inner(),
            receiver_identity_key.public_key().inner(),
            *sender_ratchet_key.inner(),
            counter,
            previous_counter,
            ciphertext.to_vec(),
        );
        Ok(Self {
            inner,
            ratchet_key: sender_ratchet_key,
        })
    }

    pub(crate) fn from_inner(inner: rv_signal::SignalMessage) -> Self {
        let ratchet_key = PublicKey::from_inner(inner.ratchet_key);
        Self { inner, ratchet_key }
    }

    pub fn message_version(&self) -> u8 {
        CIPHERTEXT_MESSAGE_CURRENT_VERSION
    }

    pub fn sender_ratchet_key(&self) -> &PublicKey {
        &self.ratchet_key
    }

    pub fn counter(&self) -> u32 {
        self.inner.counter
    }

    pub fn previous_counter(&self) -> u32 {
        self.inner.previous_counter
    }

    pub fn body(&self) -> &[u8] {
        &self.inner.ciphertext
    }

    pub fn serialized(&self) -> &[u8] {
        self.inner.serialized()
    }

    pub fn into_serialized(self) -> Box<[u8]> {
        self.inner.serialized().into()
    }
}

impl TryFrom<&[u8]> for SignalMessage {
    type Error = SignalProtocolError;
    fn try_from(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 1 + 8 {
            return Err(SignalProtocolError::CiphertextMessageTooShort(bytes.len()));
        }
        rv_signal::SignalMessage::deserialize(bytes)
            .map(Self::from_inner)
            .map_err(|e| SignalProtocolError::from_signal(e, CiphertextMessageType::Whisper))
    }
}

impl TryFrom<Bytes> for SignalMessage {
    type Error = SignalProtocolError;
    fn try_from(bytes: Bytes) -> Result<Self> {
        Self::try_from(bytes.as_ref())
    }
}

/// A `pkmsg`.
#[derive(Clone, Debug)]
pub struct PreKeySignalMessage {
    pub(crate) inner: rv_signal::PreKeySignalMessage,
    message: SignalMessage,
    base_key: PublicKey,
    identity_key: IdentityKey,
}

impl PreKeySignalMessage {
    pub fn new(
        message_version: u8,
        registration_id: u32,
        pre_key_id: Option<PreKeyId>,
        signed_pre_key_id: SignedPreKeyId,
        base_key: PublicKey,
        identity_key: IdentityKey,
        message: SignalMessage,
    ) -> Result<Self> {
        check_version(message_version)?;
        let inner = rv_signal::PreKeySignalMessage::new(
            registration_id,
            pre_key_id.map(u32::from),
            signed_pre_key_id.into(),
            *base_key.inner(),
            *identity_key.public_key().inner(),
            message.inner.clone(),
        );
        Ok(Self {
            inner,
            message,
            base_key,
            identity_key,
        })
    }

    pub(crate) fn from_inner(inner: rv_signal::PreKeySignalMessage) -> Self {
        Self {
            message: SignalMessage::from_inner(inner.message.clone()),
            base_key: PublicKey::from_inner(inner.base_key),
            identity_key: IdentityKey::new(PublicKey::from_inner(inner.identity_key)),
            inner,
        }
    }

    pub fn message_version(&self) -> u8 {
        CIPHERTEXT_MESSAGE_CURRENT_VERSION
    }

    pub fn registration_id(&self) -> u32 {
        self.inner.registration_id
    }

    pub fn pre_key_id(&self) -> Option<PreKeyId> {
        self.inner.prekey_id.map(PreKeyId::from)
    }

    pub fn signed_pre_key_id(&self) -> SignedPreKeyId {
        self.inner.signed_prekey_id.into()
    }

    pub fn base_key(&self) -> &PublicKey {
        &self.base_key
    }

    pub fn identity_key(&self) -> &IdentityKey {
        &self.identity_key
    }

    pub fn message(&self) -> &SignalMessage {
        &self.message
    }

    pub fn serialized(&self) -> &[u8] {
        self.inner.serialized()
    }

    pub fn into_serialized(self) -> Box<[u8]> {
        self.inner.serialized().into()
    }
}

impl TryFrom<&[u8]> for PreKeySignalMessage {
    type Error = SignalProtocolError;
    fn try_from(bytes: &[u8]) -> Result<Self> {
        if bytes.is_empty() {
            return Err(SignalProtocolError::CiphertextMessageTooShort(0));
        }
        rv_signal::PreKeySignalMessage::deserialize(bytes)
            .map(Self::from_inner)
            .map_err(|e| SignalProtocolError::from_signal(e, CiphertextMessageType::PreKey))
    }
}

impl TryFrom<Bytes> for PreKeySignalMessage {
    type Error = SignalProtocolError;
    fn try_from(bytes: Bytes) -> Result<Self> {
        Self::try_from(bytes.as_ref())
    }
}

/// An `skmsg`.
#[derive(Clone, Debug)]
pub struct SenderKeyMessage {
    pub(crate) inner: rv_signal::SenderKeyMessage,
}

impl SenderKeyMessage {
    pub fn new<R: CryptoRng + ?Sized>(
        message_version: u8,
        chain_id: u32,
        iteration: u32,
        ciphertext: Box<[u8]>,
        csprng: &mut R,
        signature_key: &PrivateKey,
    ) -> Result<Self> {
        check_version(message_version)?;
        Ok(Self {
            inner: rv_signal::SenderKeyMessage::new(
                chain_id,
                iteration,
                ciphertext.into_vec(),
                &signature_key.inner(),
                csprng,
            ),
        })
    }

    pub fn message_version(&self) -> u8 {
        SENDERKEY_MESSAGE_CURRENT_VERSION
    }

    pub fn chain_id(&self) -> u32 {
        self.inner.chain_id
    }

    pub fn iteration(&self) -> u32 {
        self.inner.iteration
    }

    pub fn ciphertext(&self) -> Result<&[u8]> {
        Ok(&self.inner.ciphertext)
    }

    pub fn verify_signature(&self, signature_key: &PublicKey) -> Result<bool> {
        Ok(self.inner.verify_signature(signature_key.inner()))
    }

    pub fn serialized(&self) -> &[u8] {
        self.inner.serialized()
    }

    pub fn into_serialized(self) -> Box<[u8]> {
        self.inner.serialized().into()
    }
}

impl TryFrom<&[u8]> for SenderKeyMessage {
    type Error = SignalProtocolError;
    fn try_from(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 1 + 64 {
            return Err(SignalProtocolError::CiphertextMessageTooShort(bytes.len()));
        }
        rv_signal::SenderKeyMessage::deserialize(bytes)
            .map(|inner| Self { inner })
            .map_err(|e| SignalProtocolError::from_signal(e, CiphertextMessageType::SenderKey))
    }
}

impl TryFrom<Bytes> for SenderKeyMessage {
    type Error = SignalProtocolError;
    fn try_from(bytes: Bytes) -> Result<Self> {
        Self::try_from(bytes.as_ref())
    }
}

/// A sender key, shared over the pairwise sessions.
#[derive(Clone, Debug)]
pub struct SenderKeyDistributionMessage {
    pub(crate) inner: rv_signal::SenderKeyDistributionMessage,
    signing_key: PublicKey,
}

impl SenderKeyDistributionMessage {
    pub fn new(
        message_version: u8,
        chain_id: u32,
        iteration: u32,
        chain_key: [u8; 32],
        signing_key: PublicKey,
    ) -> Result<Self> {
        check_version(message_version)?;
        Ok(Self::from_inner(
            rv_signal::SenderKeyDistributionMessage::new(
                chain_id,
                iteration,
                chain_key,
                *signing_key.inner(),
            ),
        ))
    }

    pub(crate) fn from_inner(inner: rv_signal::SenderKeyDistributionMessage) -> Self {
        let signing_key = PublicKey::from_inner(inner.signing_key);
        Self { inner, signing_key }
    }

    pub fn message_version(&self) -> u8 {
        SENDERKEY_MESSAGE_CURRENT_VERSION
    }

    pub fn chain_id(&self) -> u32 {
        self.inner.chain_id
    }

    pub fn iteration(&self) -> u32 {
        self.inner.iteration
    }

    pub fn chain_key(&self) -> &[u8] {
        &self.inner.chain_key
    }

    pub fn signing_key(&self) -> &PublicKey {
        &self.signing_key
    }

    pub fn serialized(&self) -> &[u8] {
        self.inner.serialized()
    }

    pub fn into_serialized(self) -> Box<[u8]> {
        self.inner.serialized().into()
    }
}

impl TryFrom<&[u8]> for SenderKeyDistributionMessage {
    type Error = SignalProtocolError;
    fn try_from(bytes: &[u8]) -> Result<Self> {
        rv_signal::SenderKeyDistributionMessage::deserialize(bytes)
            .map(Self::from_inner)
            .map_err(|e| SignalProtocolError::from_signal(e, CiphertextMessageType::SenderKey))
    }
}

#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug)]
pub enum CiphertextMessage {
    SignalMessage(SignalMessage),
    PreKeySignalMessage(PreKeySignalMessage),
    SenderKeyMessage(SenderKeyMessage),
    PlaintextContent(Bytes),
}

impl CiphertextMessage {
    pub fn message_type(&self) -> CiphertextMessageType {
        match self {
            Self::SignalMessage(_) => CiphertextMessageType::Whisper,
            Self::PreKeySignalMessage(_) => CiphertextMessageType::PreKey,
            Self::SenderKeyMessage(_) => CiphertextMessageType::SenderKey,
            Self::PlaintextContent(_) => CiphertextMessageType::Plaintext,
        }
    }

    pub fn serialize(&self) -> &[u8] {
        match self {
            Self::SignalMessage(m) => m.serialized(),
            Self::PreKeySignalMessage(m) => m.serialized(),
            Self::SenderKeyMessage(m) => m.serialized(),
            Self::PlaintextContent(b) => b,
        }
    }
}

/// A message a decrypt may take the bytes of.
#[derive(Clone, Debug)]
pub struct OwnedCiphertextMessage(Option<CiphertextMessage>);

impl OwnedCiphertextMessage {
    pub fn new(message: CiphertextMessage) -> Self {
        Self(Some(message))
    }

    pub fn is_available(&self) -> bool {
        self.0.is_some()
    }

    pub(crate) fn get(&self) -> Option<&CiphertextMessage> {
        self.0.as_ref()
    }
}

impl From<CiphertextMessage> for OwnedCiphertextMessage {
    fn from(message: CiphertextMessage) -> Self {
        Self::new(message)
    }
}
