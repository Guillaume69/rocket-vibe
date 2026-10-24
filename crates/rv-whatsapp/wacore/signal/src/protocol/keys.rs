//! Curve25519 keys in the shapes the engine uses: a public key known by its
//! 33-byte serialized form or its 32 raw ("djb") bytes, key pairs with named
//! fields, identity keys.

use rand::CryptoRng;
use zeroize::Zeroize;

use super::error::{CurveError, Result, SignalProtocolError};

const KEY_TYPE: u8 = rv_signal::KEY_TYPE;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct PublicKey(rv_signal::PublicKey);

impl PublicKey {
    pub(crate) fn from_inner(inner: rv_signal::PublicKey) -> Self {
        Self(inner)
    }

    pub(crate) fn inner(&self) -> &rv_signal::PublicKey {
        &self.0
    }

    /// The 33-byte form: type byte, then the key.
    pub fn deserialize(value: &[u8]) -> std::result::Result<Self, CurveError> {
        match value {
            [] => Err(CurveError::NoKeyTypeIdentifier),
            [KEY_TYPE, rest @ ..] if rest.len() == 32 => Self::from_djb_public_key_bytes(rest),
            [KEY_TYPE, ..] => Err(CurveError::BadKeyLength(value.len())),
            [kind, ..] => Err(CurveError::BadKeyType(*kind)),
        }
    }

    /// The 32 raw bytes.
    pub fn from_djb_public_key_bytes(bytes: &[u8]) -> std::result::Result<Self, CurveError> {
        let raw: [u8; 32] = bytes
            .try_into()
            .map_err(|_| CurveError::BadKeyLength(bytes.len()))?;
        Ok(Self(rv_signal::PublicKey::from_raw(raw)))
    }

    pub fn public_key_bytes(&self) -> &[u8] {
        self.0.raw()
    }

    pub fn serialize(&self) -> Box<[u8]> {
        Box::new(self.0.serialize())
    }

    pub fn verify_signature(&self, message: &[u8], signature: &[u8]) -> bool {
        signature
            .try_into()
            .is_ok_and(|signature: &[u8; 64]| self.0.verify(message, signature))
    }
}

impl From<IdentityKey> for PublicKey {
    fn from(key: IdentityKey) -> Self {
        key.0
    }
}

/// A private key, clamped.
#[derive(Clone)]
pub struct PrivateKey([u8; 32]);

impl Drop for PrivateKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl std::fmt::Debug for PrivateKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PrivateKey(..)")
    }
}

impl PrivateKey {
    pub(crate) fn inner(&self) -> rv_signal::PrivateKey {
        rv_signal::PrivateKey::from_bytes(self.0)
    }

    pub(crate) fn from_inner(inner: &rv_signal::PrivateKey) -> Self {
        Self(inner.serialize())
    }

    pub fn new<R: CryptoRng + ?Sized>(csprng: &mut R) -> Self {
        Self::from_inner(&rv_signal::PrivateKey::generate(csprng))
    }

    pub fn deserialize(value: &[u8]) -> std::result::Result<Self, CurveError> {
        let bytes: [u8; 32] = value
            .try_into()
            .map_err(|_| CurveError::BadKeyLength(value.len()))?;
        Ok(Self::from_inner(&rv_signal::PrivateKey::from_bytes(bytes)))
    }

    pub fn serialize(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn public_key(&self) -> std::result::Result<PublicKey, CurveError> {
        Ok(PublicKey(self.inner().public_key()))
    }

    pub fn calculate_agreement(
        &self,
        their_key: &PublicKey,
    ) -> std::result::Result<[u8; 32], CurveError> {
        self.inner()
            .agree(their_key.inner())
            .map_err(|_| CurveError::AgreementFailed)
    }

    pub fn calculate_signature<R: CryptoRng + ?Sized>(
        &self,
        message: &[u8],
        csprng: &mut R,
    ) -> std::result::Result<[u8; 64], CurveError> {
        Ok(self.inner().sign(message, csprng))
    }
}

#[derive(Clone, Debug)]
pub struct KeyPair {
    pub public_key: PublicKey,
    pub private_key: PrivateKey,
}

impl KeyPair {
    pub fn new(public_key: PublicKey, private_key: PrivateKey) -> Self {
        Self {
            public_key,
            private_key,
        }
    }

    pub fn generate<R: CryptoRng + ?Sized>(csprng: &mut R) -> Self {
        let pair = rv_signal::KeyPair::generate(csprng);
        Self {
            public_key: PublicKey(pair.public),
            private_key: PrivateKey::from_inner(&pair.private),
        }
    }

    pub(crate) fn inner(&self) -> rv_signal::KeyPair {
        rv_signal::KeyPair {
            private: self.private_key.inner(),
            public: *self.public_key.inner(),
        }
    }

    pub fn calculate_agreement(
        &self,
        their_key: &PublicKey,
    ) -> std::result::Result<[u8; 32], CurveError> {
        self.private_key.calculate_agreement(their_key)
    }

    pub fn calculate_signature<R: CryptoRng + ?Sized>(
        &self,
        message: &[u8],
        csprng: &mut R,
    ) -> std::result::Result<[u8; 64], CurveError> {
        self.private_key.calculate_signature(message, csprng)
    }
}

impl TryFrom<PrivateKey> for KeyPair {
    type Error = SignalProtocolError;
    fn try_from(private_key: PrivateKey) -> Result<Self> {
        Ok(Self {
            public_key: private_key.public_key()?,
            private_key,
        })
    }
}

impl From<IdentityKeyPair> for KeyPair {
    fn from(pair: IdentityKeyPair) -> Self {
        Self {
            public_key: pair.identity_key.0,
            private_key: pair.private_key,
        }
    }
}

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
        self.0.serialize()
    }
}

impl From<PublicKey> for IdentityKey {
    fn from(key: PublicKey) -> Self {
        Self(key)
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
            identity: rv_signal::KeyPair {
                private: self.private_key.inner(),
                public: *self.public_key().inner(),
            },
            registration_id,
        }
    }
}

impl From<KeyPair> for IdentityKeyPair {
    fn from(pair: KeyPair) -> Self {
        Self {
            identity_key: IdentityKey(pair.public_key),
            private_key: pair.private_key,
        }
    }
}

impl TryFrom<PrivateKey> for IdentityKeyPair {
    type Error = SignalProtocolError;
    fn try_from(private_key: PrivateKey) -> Result<Self> {
        Ok(KeyPair::try_from(private_key)?.into())
    }
}
