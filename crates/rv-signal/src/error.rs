#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("bad key type {0:#04x}")]
    BadKeyType(u8),
    #[error("bad key length {0}")]
    BadKeyLength(usize),
    #[error("invalid key")]
    InvalidKey,
    #[error("invalid protobuf: {0}")]
    InvalidProtobuf(&'static str),
    #[error("unsupported message version {0}")]
    UnsupportedVersion(u8),
    #[error("invalid message: {0}")]
    InvalidMessage(&'static str),
    #[error("bad MAC")]
    BadMac,
    #[error("bad signature")]
    BadSignature,
    #[error("duplicated message (chain index {0})")]
    DuplicatedMessage(u32),
    #[error("message too far ahead (jump of {0})")]
    TooFarAhead(u32),
    #[error("no session")]
    NoSession,
    #[error("no sender key for this group and sender")]
    NoSenderKey,
    #[error("unknown prekey {0}")]
    UnknownPreKey(u32),
    #[error("unknown signed prekey {0}")]
    UnknownSignedPreKey(u32),
}

pub type Result<T> = std::result::Result<T, Error>;
