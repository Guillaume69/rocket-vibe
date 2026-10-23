//! Curve25519 keys: X25519 agreement and XEdDSA signatures (Signal's XEdDSA
//! specification, revision 1).

use curve25519_dalek::constants::ED25519_BASEPOINT_TABLE;
use curve25519_dalek::edwards::{CompressedEdwardsY, EdwardsPoint};
use curve25519_dalek::montgomery::MontgomeryPoint;
use curve25519_dalek::scalar::{Scalar, clamp_integer};
use rand_core::CryptoRng;
use sha2::{Digest, Sha512};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::{Error, Result};

/// The type byte in front of a serialized public key.
pub const KEY_TYPE: u8 = 0x05;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct PublicKey([u8; 32]);

impl PublicKey {
    pub fn from_raw(raw: [u8; 32]) -> Self {
        Self(raw)
    }

    /// The 33-byte form (type byte, then the key).
    pub fn deserialize(bytes: &[u8]) -> Result<Self> {
        match bytes {
            [KEY_TYPE, rest @ ..] if rest.len() == 32 => {
                Ok(Self(rest.try_into().expect("32 bytes")))
            }
            [KEY_TYPE, ..] => Err(Error::BadKeyLength(bytes.len())),
            [kind, ..] => Err(Error::BadKeyType(*kind)),
            [] => Err(Error::BadKeyLength(0)),
        }
    }

    pub fn serialize(&self) -> [u8; 33] {
        let mut out = [KEY_TYPE; 33];
        out[1..].copy_from_slice(&self.0);
        out
    }

    pub fn raw(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn verify(&self, message: &[u8], signature: &[u8; 64]) -> bool {
        xeddsa_verify(&self.0, message, signature)
    }
}

/// A private key, clamped as X25519 uses it.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct PrivateKey([u8; 32]);

impl PrivateKey {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(clamp_integer(bytes))
    }

    pub fn deserialize(bytes: &[u8]) -> Result<Self> {
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| Error::BadKeyLength(bytes.len()))?;
        Ok(Self::from_bytes(bytes))
    }

    pub fn generate<R: CryptoRng + ?Sized>(rng: &mut R) -> Self {
        let mut bytes = [0u8; 32];
        rng.fill_bytes(&mut bytes);
        let key = Self::from_bytes(bytes);
        bytes.zeroize();
        key
    }

    pub fn serialize(&self) -> [u8; 32] {
        self.0
    }

    pub fn public_key(&self) -> PublicKey {
        PublicKey(MontgomeryPoint::mul_base_clamped(self.0).to_bytes())
    }

    /// X25519; a low-order peer key, whose output is all zeros, is refused.
    pub fn agree(&self, public: &PublicKey) -> Result<[u8; 32]> {
        let shared = MontgomeryPoint(public.0).mul_clamped(self.0).to_bytes();
        if shared == [0u8; 32] {
            return Err(Error::InvalidKey);
        }
        Ok(shared)
    }

    pub fn sign<R: CryptoRng + ?Sized>(&self, message: &[u8], rng: &mut R) -> [u8; 64] {
        let mut z = [0u8; 64];
        rng.fill_bytes(&mut z);
        let signature = xeddsa_sign(&self.0, message, &z);
        z.zeroize();
        signature
    }
}

impl std::fmt::Debug for PrivateKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PrivateKey(..)")
    }
}

#[derive(Clone, Debug)]
pub struct KeyPair {
    pub private: PrivateKey,
    pub public: PublicKey,
}

impl KeyPair {
    pub fn from_private(private: PrivateKey) -> Self {
        let public = private.public_key();
        Self { private, public }
    }

    pub fn generate<R: CryptoRng + ?Sized>(rng: &mut R) -> Self {
        Self::from_private(PrivateKey::generate(rng))
    }
}

/// The twisted Edwards key pair of a Montgomery private key, its public key's
/// sign bit forced to zero.
fn calculate_key_pair(k: &[u8; 32]) -> ([u8; 32], Scalar) {
    let k = Scalar::from_bytes_mod_order(*k);
    let e = (&k * ED25519_BASEPOINT_TABLE).compress().to_bytes();
    let negative = e[31] >> 7 == 1;
    let a = if negative { -k } else { k };
    let mut public = e;
    public[31] &= 0x7f;
    (public, a)
}

/// hash_1: SHA-512 behind the 32-byte little-endian encoding of 2^256 - 2.
fn hash1(parts: &[&[u8]]) -> Scalar {
    let mut prefix = [0xffu8; 32];
    prefix[0] = 0xfe;
    let mut hash = Sha512::new();
    hash.update(prefix);
    for part in parts {
        hash.update(part);
    }
    Scalar::from_bytes_mod_order_wide(&hash.finalize().into())
}

fn hash(parts: &[&[u8]]) -> Scalar {
    let mut hash = Sha512::new();
    for part in parts {
        hash.update(part);
    }
    Scalar::from_bytes_mod_order_wide(&hash.finalize().into())
}

fn xeddsa_sign(k: &[u8; 32], message: &[u8], z: &[u8; 64]) -> [u8; 64] {
    let (public, a) = calculate_key_pair(k);
    let r = hash1(&[a.as_bytes(), message, z]);
    let big_r = (&r * ED25519_BASEPOINT_TABLE).compress().to_bytes();
    let h = hash(&[&big_r, &public, message]);
    let s = r + h * a;
    let mut signature = [0u8; 64];
    signature[..32].copy_from_slice(&big_r);
    signature[32..].copy_from_slice(s.as_bytes());
    signature
}

/// p = 2^255 - 19, little-endian.
const P: [u8; 32] = {
    let mut p = [0xffu8; 32];
    p[0] = 0xed;
    p[31] = 0x7f;
    p
};

fn less_than(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        if a[i] != b[i] {
            return a[i] < b[i];
        }
    }
    false
}

/// The spec's verification, widened to the form other Signal implementations
/// sign with: the Edwards key's sign bit in the top bit of `s` (zero in the
/// spec's own signatures), instead of a negated private key.
fn xeddsa_verify(u: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    let big_r: [u8; 32] = signature[..32].try_into().expect("32 bytes");
    let mut s: [u8; 32] = signature[32..].try_into().expect("32 bytes");
    let sign = s[31] >> 7;
    s[31] &= 0x7f;
    if !less_than(u, &P) || s[31] & 0xe0 != 0 {
        return false;
    }
    let Some(a) = MontgomeryPoint(*u).to_edwards(sign) else {
        return false;
    };
    let Some(s) = Option::<Scalar>::from(Scalar::from_canonical_bytes(s)) else {
        return false;
    };
    let public = a.compress().to_bytes();
    let h = hash(&[&big_r, &public, message]);
    let check = EdwardsPoint::vartime_double_scalar_mul_basepoint(&-h, &a, &s);
    CompressedEdwardsY(big_r) == check.compress()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Counter(u8);

    impl rand_core::TryRng for Counter {
        type Error = std::convert::Infallible;
        fn try_next_u32(&mut self) -> std::result::Result<u32, Self::Error> {
            Ok(self.0 as u32)
        }
        fn try_next_u64(&mut self) -> std::result::Result<u64, Self::Error> {
            Ok(self.0 as u64)
        }
        fn try_fill_bytes(&mut self, dst: &mut [u8]) -> std::result::Result<(), Self::Error> {
            for b in dst {
                self.0 = self.0.wrapping_add(1);
                *b = self.0;
            }
            Ok(())
        }
    }
    impl rand_core::TryCryptoRng for Counter {}

    #[test]
    fn agreement_is_symmetric() {
        let mut rng = Counter(0);
        let (a, b) = (KeyPair::generate(&mut rng), KeyPair::generate(&mut rng));
        assert_eq!(
            a.private.agree(&b.public).unwrap(),
            b.private.agree(&a.public).unwrap()
        );
    }

    #[test]
    fn signatures_verify_and_reject_tampering() {
        let mut rng = Counter(7);
        for _ in 0..16 {
            let pair = KeyPair::generate(&mut rng);
            let signature = pair.private.sign(b"hello", &mut rng);
            assert!(pair.public.verify(b"hello", &signature));
            assert!(!pair.public.verify(b"hellp", &signature));
            let mut bad = signature;
            bad[10] ^= 1;
            assert!(!pair.public.verify(b"hello", &bad));
        }
    }

    #[test]
    fn serialized_public_key_round_trips() {
        let pair = KeyPair::generate(&mut Counter(3));
        let bytes = pair.public.serialize();
        assert_eq!(bytes[0], KEY_TYPE);
        assert_eq!(PublicKey::deserialize(&bytes).unwrap(), pair.public);
        assert!(matches!(
            PublicKey::deserialize(&[1; 33]),
            Err(Error::BadKeyType(1))
        ));
    }
}
