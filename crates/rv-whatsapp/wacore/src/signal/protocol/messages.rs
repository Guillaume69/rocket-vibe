//! The four message kinds are `rv-signal`'s own. Here: their parsing with
//! the errors the engine classifies, and the envelope a decrypt takes.

use bytes::Bytes;

use super::error::{Result, SignalProtocolError};

pub use rv_signal::{
    PreKeySignalMessage, SenderKeyDistributionMessage, SenderKeyMessage, SignalMessage,
};

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

/// A `msg`.
pub fn signal_message(bytes: &[u8]) -> Result<SignalMessage> {
    if bytes.len() < 1 + 8 {
        return Err(SignalProtocolError::CiphertextMessageTooShort(bytes.len()));
    }
    SignalMessage::deserialize(bytes)
        .map_err(|e| SignalProtocolError::from_signal(e, CiphertextMessageType::Whisper))
}

/// A `pkmsg`.
pub fn prekey_signal_message(bytes: &[u8]) -> Result<PreKeySignalMessage> {
    if bytes.is_empty() {
        return Err(SignalProtocolError::CiphertextMessageTooShort(0));
    }
    PreKeySignalMessage::deserialize(bytes)
        .map_err(|e| SignalProtocolError::from_signal(e, CiphertextMessageType::PreKey))
}

/// An `skmsg`.
pub fn sender_key_message(bytes: &[u8]) -> Result<SenderKeyMessage> {
    if bytes.len() < 1 + 64 {
        return Err(SignalProtocolError::CiphertextMessageTooShort(bytes.len()));
    }
    SenderKeyMessage::deserialize(bytes)
        .map_err(|e| SignalProtocolError::from_signal(e, CiphertextMessageType::SenderKey))
}

/// A sender key distribution message.
pub fn sender_key_distribution_message(bytes: &[u8]) -> Result<SenderKeyDistributionMessage> {
    SenderKeyDistributionMessage::deserialize(bytes)
        .map_err(|e| SignalProtocolError::from_signal(e, CiphertextMessageType::SenderKey))
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
