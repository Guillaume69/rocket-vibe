//! Curve25519 keys are `rv-signal`'s own; identity keys, as the engine names
//! them, are built on them.

use rand::CryptoRng;

use super::error::{Result, SignalProtocolError};

pub use rv_signal::{KeyPair, PrivateKey, PublicKey};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct IdentityKey(PublicKey);

impl IdentityKey {
    pub fn new(public_key: PublicKey) -> Self {
        Self(public_key)
    }

    /// The 33-byte serialized form.
    pub fn decode(value: &[u8]) -> Result<Self> {
        Ok(Self(PublicKey::deserialize(value)?))
    }

    pub fn public_key(&self) -> &PublicKey {
        &self.0
    }

    pub fn serialize(&self) -> Box<[u8]> {
        Box::new(self.0.serialize())
    }
}

impl From<PublicKey> for IdentityKey {
    fn from(key: PublicKey) -> Self {
        Self(key)
    }
}

impl From<IdentityKey> for PublicKey {
    fn from(key: IdentityKey) -> Self {
        key.0
    }
}

#[derive(Clone, Debug)]
pub struct IdentityKeyPair {
    identity_key: IdentityKey,
    private_key: PrivateKey,
}

impl IdentityKeyPair {
    pub fn new(identity_key: IdentityKey, private_key: PrivateKey) -> Self {
        Self {
            identity_key,
            private_key,
        }
    }

    pub fn generate<R: CryptoRng + ?Sized>(csprng: &mut R) -> Self {
        KeyPair::generate(csprng).into()
    }

    pub fn identity_key(&self) -> &IdentityKey {
        &self.identity_key
    }

    pub fn public_key(&self) -> &PublicKey {
        &self.identity_key.0
    }

    pub fn private_key(&self) -> &PrivateKey {
        &self.private_key
    }

    /// `IdentityKeyPairStructure`.
    pub fn serialize(&self) -> Box<[u8]> {
        let mut structure = waproto::whatsapp::IdentityKeyPairStructure::default();
        structure.public_key = Some(self.identity_key.serialize().into_vec());
        structure.private_key = Some(self.private_key.serialize().to_vec());
        waproto::codec::identity_key_pair_to_vec(&structure).into_boxed_slice()
    }

    pub(crate) fn local(&self, registration_id: u32) -> rv_signal::LocalIdentity {
        rv_signal::LocalIdentity {
            identity: KeyPair {
                private: self.private_key.clone(),
                public: *self.public_key(),
            },
            registration_id,
        }
    }
}

impl From<KeyPair> for IdentityKeyPair {
    fn from(pair: KeyPair) -> Self {
        Self {
            identity_key: IdentityKey(pair.public),
            private_key: pair.private,
        }
    }
}

impl From<IdentityKeyPair> for KeyPair {
    fn from(pair: IdentityKeyPair) -> Self {
        Self {
            public: pair.identity_key.0,
            private: pair.private_key,
        }
    }
}

impl TryFrom<PrivateKey> for IdentityKeyPair {
    type Error = SignalProtocolError;
    fn try_from(private_key: PrivateKey) -> Result<Self> {
        Ok(KeyPair::from_private(private_key).into())
    }
}
