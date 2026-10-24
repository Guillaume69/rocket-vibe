mod address;
mod cipher;
pub mod consts;
mod envelope;
pub mod error;
mod group;
mod keys;
mod messages;
mod prekeys;
mod sender_keys;
mod session;
mod storage;

pub use crate::signal::store::sender_key_name::SenderKeyName;
pub use address::{AddressBuf, DeviceId, ProtocolAddress};
pub use cipher::{
    DecryptionResult, PreKeyBundle, SIGNED_PRE_KEY_SIGNATURE_LEN, initialize_alice_session_record,
    message_decrypt, message_decrypt_owned, message_decrypt_prekey, message_decrypt_signal,
    message_encrypt, prekey_bundle, process_prekey_bundle,
};
pub use error::{
    CurveError, InvalidSenderKeySessionError, InvalidSessionError, Result, SignalProtocolError,
};
pub use group::{
    create_sender_key_distribution_message, group_decrypt, group_decrypt_shared, group_encrypt,
    process_sender_key_distribution_message,
};
pub use keys::{KeyPair, PrivateKey, PublicKey};
pub use messages::{
    CiphertextMessage, CiphertextMessageType, OwnedCiphertextMessage, PreKeySignalMessage,
    SenderKeyDistributionMessage, SenderKeyMessage, SignalMessage, prekey_signal_message,
    sender_key_distribution_message, sender_key_message, signal_message,
};
pub use prekeys::{
    GenericSignedPreKey, PreKeyId, PreKeyRecord, SignedPreKeyId, SignedPreKeyRecord, Timestamp,
};
pub use sender_keys::{SenderChainKey, SenderKeyRecord, SenderKeyState};
pub use session::{
    AliceSignalProtocolParameters, ChainKey, MessageKeyGenerator, MessageKeys, RootKey,
    SessionRecord, SessionState, UnacknowledgedPreKeyMessageItems, UsePQRatchet,
};
pub use storage::{
    Direction, IdentityChange, IdentityKeyStore, PreKeyStore, SenderKeyStore, SessionCheckout,
    SessionCheckoutKey, SessionCheckoutStoreResult, SessionStore, SignedPreKeyStore, ThreadSafe,
    has_session, is_trusted_identity,
};
