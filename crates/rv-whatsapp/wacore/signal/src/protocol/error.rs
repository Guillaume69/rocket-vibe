use std::error::Error as StdError;

use thiserror::Error;

use super::messages::CiphertextMessageType;
use wacore_crypto::CryptoProviderError;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum CurveError {
    #[error("no key type identifier")]
    NoKeyTypeIdentifier,
    #[error("bad key type {0:#04x}")]
    BadKeyType(u8),
    #[error("bad key length {0}")]
    BadKeyLength(usize),
    #[error("key agreement failed")]
    AgreementFailed,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("invalid session: {0}")]
pub struct InvalidSessionError(pub &'static str);

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("invalid sender key session: {0}")]
pub struct InvalidSenderKeySessionError(pub &'static str);

#[derive(Debug, Error)]
pub enum SignalProtocolError {
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("invalid state for {0}: {1}")]
    InvalidState(&'static str, String),
    #[error("{0}: {1}")]
    BackendError(&'static str, Box<dyn StdError + Send + Sync>),
    #[error("protobuf encoding was invalid")]
    InvalidProtobufEncoding,
    #[error("ciphertext serialized bytes were too short <{0}>")]
    CiphertextMessageTooShort(usize),
    #[error("ciphertext version was too old <{0}>")]
    LegacyCiphertextVersion(u8),
    #[error("ciphertext version was unrecognized <{0}>")]
    UnrecognizedCiphertextVersion(u8),
    #[error("unrecognized message version <{0}>")]
    UnrecognizedMessageVersion(u32),
    #[error("no key type identifier")]
    NoKeyTypeIdentifier,
    #[error("bad key type <{0:#04x}>")]
    BadKeyType(u8),
    #[error("bad key length <{0}>")]
    BadKeyLength(usize),
    #[error("signature validation failed")]
    SignatureValidationFailed,
    #[error("key agreement failed: {0}")]
    KeyAgreementFailed(CryptoProviderError),
    #[error("untrusted identity for address {0}")]
    UntrustedIdentity(super::ProtocolAddress),
    #[error("invalid prekey identifier")]
    InvalidPreKeyId,
    #[error("invalid signed prekey identifier")]
    InvalidSignedPreKeyId,
    #[error("no sender key state: {0}")]
    NoSenderKeyState(String),
    #[error("session with {0} not found")]
    SessionNotFound(super::ProtocolAddress),
    #[error("invalid session structure: {0}")]
    InvalidSessionStructure(&'static str),
    #[error("invalid sender key session")]
    InvalidSenderKeySession,
    #[error("message with old counter {0} / {1}")]
    DuplicatedMessage(u32, u32),
    #[error("invalid {0:?} message: {1}")]
    InvalidMessage(CiphertextMessageType, &'static str),
    #[error("MAC verification failed for {0:?} message")]
    BadMac(CiphertextMessageType),
}

impl SignalProtocolError {
    /// A stored record of ours that no longer decodes: the store's fault, not
    /// the peer's.
    pub fn is_stored_session_corruption(&self) -> bool {
        match self {
            Self::BackendError(context, _) => *context == "stored record",
            Self::InvalidSenderKeySession => true,
            // A chain closed by the protocol says something about the message.
            Self::InvalidSessionStructure(why) => *why != "receiver chain is closed",
            _ => false,
        }
    }

    /// `rv-signal`'s error, for a message of `kind`.
    pub(crate) fn from_signal(e: rv_signal::Error, kind: CiphertextMessageType) -> Self {
        use rv_signal::Error as E;
        match e {
            E::BadKeyType(t) => Self::BadKeyType(t),
            E::BadKeyLength(n) => Self::BadKeyLength(n),
            E::InvalidKey => Self::KeyAgreementFailed(CryptoProviderError::BadInput),
            E::InvalidProtobuf(_) => Self::InvalidProtobufEncoding,
            E::UnsupportedVersion(v) if v < 3 => Self::LegacyCiphertextVersion(v),
            E::UnsupportedVersion(v) => Self::UnrecognizedMessageVersion(u32::from(v)),
            E::InvalidMessage(why) => Self::InvalidMessage(kind, why),
            E::BadMac => Self::BadMac(kind),
            E::BadSignature => Self::SignatureValidationFailed,
            E::DuplicatedMessage(counter) => Self::DuplicatedMessage(counter, counter),
            E::TooFarAhead(_) => Self::InvalidMessage(kind, "message from too far into the future"),
            E::NoSession => Self::InvalidSessionStructure("no usable session state"),
            E::NoSenderKey => {
                Self::NoSenderKeyState("no sender key state for this message".to_owned())
            }
            E::UnknownPreKey(_) => Self::InvalidPreKeyId,
            E::UnknownSignedPreKey(_) => Self::InvalidSignedPreKeyId,
        }
    }
}

impl From<CurveError> for SignalProtocolError {
    fn from(e: CurveError) -> Self {
        match e {
            CurveError::NoKeyTypeIdentifier => Self::NoKeyTypeIdentifier,
            CurveError::BadKeyType(t) => Self::BadKeyType(t),
            CurveError::BadKeyLength(n) => Self::BadKeyLength(n),
            CurveError::AgreementFailed => Self::KeyAgreementFailed(CryptoProviderError::BadInput),
        }
    }
}

impl From<rv_signal::Error> for CurveError {
    fn from(e: rv_signal::Error) -> Self {
        match e {
            rv_signal::Error::BadKeyType(t) => Self::BadKeyType(t),
            rv_signal::Error::BadKeyLength(0) => Self::NoKeyTypeIdentifier,
            rv_signal::Error::BadKeyLength(n) => Self::BadKeyLength(n),
            _ => Self::AgreementFailed,
        }
    }
}

impl From<rv_signal::Error> for SignalProtocolError {
    fn from(e: rv_signal::Error) -> Self {
        Self::from_signal(e, CiphertextMessageType::Whisper)
    }
}

impl From<InvalidSessionError> for SignalProtocolError {
    fn from(e: InvalidSessionError) -> Self {
        Self::InvalidSessionStructure(e.0)
    }
}

impl From<InvalidSenderKeySessionError> for SignalProtocolError {
    fn from(_: InvalidSenderKeySessionError) -> Self {
        Self::InvalidSenderKeySession
    }
}

pub type Result<T> = std::result::Result<T, SignalProtocolError>;
