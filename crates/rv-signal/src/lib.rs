//! The Signal protocol as WhatsApp speaks it: X3DH, the Double Ratchet and
//! sender keys, with WhatsApp's wire messages and stored records.
//!
//! Written from Signal's public specifications (X3DH, Double Ratchet,
//! XEdDSA, all placed in the public domain), WhatsApp's security whitepaper
//! and the protobuf schema whatspec extracts from WhatsApp Web; never from
//! another implementation's source (`brain/decisions.md`).

mod crypto;
mod curve;
mod error;
mod group;
mod message;
mod proto;
mod session;

pub use curve::{KEY_TYPE, KeyPair, PrivateKey, PublicKey};
pub use error::{Error, Result};
pub use group::{GroupKeys, SenderKeyRecord, SenderKeyState};
pub use message::{
    Kind, PreKeySignalMessage, SenderKeyDistributionMessage, SenderKeyMessage, SignalMessage,
};
pub use session::{
    ChainKey, Decrypted, LocalIdentity, MessageKeys, PreKeyBundle, SessionRecord, SessionState,
};

#[cfg(test)]
mod tests;
