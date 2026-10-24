//! Curve25519 keys are `rv-signal`'s own. An identity is a public key and an
//! identity key pair a key pair, as `rv-signal` has them.

pub use rv_signal::{KeyPair, PrivateKey, PublicKey};

/// This device's identity as `rv-signal` takes it, with its registration id.
pub(crate) fn local_identity(pair: &KeyPair, registration_id: u32) -> rv_signal::LocalIdentity {
    rv_signal::LocalIdentity {
        identity: pair.clone(),
        registration_id,
    }
}
