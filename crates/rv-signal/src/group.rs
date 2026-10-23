//! Sender keys, for groups: each member has one chain per group, shared with
//! the others in a distribution message sent over the pairwise sessions.
//! Records use `SenderKeyRecordStructure` of `WAProto.proto`.

use rand_core::CryptoRng;

use crate::crypto::{aes_cbc_decrypt, aes_cbc_encrypt, hkdf};
use crate::curve::{KeyPair, PrivateKey, PublicKey};
use crate::message::{SenderKeyDistributionMessage, SenderKeyMessage};
use crate::proto::{Writer, fields};
use crate::session::{ChainKey, MAX_JUMP};
use crate::{Error, Result};

/// Sender key states kept per (group, sender), newest first.
pub const MAX_STATES: usize = 5;
/// Skipped message keys kept per state.
pub const MAX_MESSAGE_KEYS: usize = 2000;

const INFO_GROUP: &[u8] = b"WhisperGroup";

struct GroupKeys {
    iv: [u8; 16],
    cipher_key: [u8; 32],
}

impl GroupKeys {
    fn derive(seed: &[u8; 32]) -> Self {
        let okm: [u8; 48] = hkdf(None, seed, INFO_GROUP);
        Self {
            iv: okm[..16].try_into().expect("16"),
            cipher_key: okm[16..].try_into().expect("32"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SenderKeyState {
    chain_id: u32,
    chain: ChainKey,
    signing_public: PublicKey,
    signing_private: Option<PrivateKey>,
    /// Skipped message seeds, by iteration.
    message_seeds: Vec<(u32, [u8; 32])>,
}

impl SenderKeyState {
    pub fn chain_id(&self) -> u32 {
        self.chain_id
    }

    /// The chain the next message is sent or expected on.
    pub fn chain_key(&self) -> &ChainKey {
        &self.chain
    }

    pub fn signing_public(&self) -> &PublicKey {
        &self.signing_public
    }

    pub fn signing_private(&self) -> Option<&PrivateKey> {
        self.signing_private.as_ref()
    }

    fn take_seed(&mut self, iteration: u32) -> Result<[u8; 32]> {
        if iteration < self.chain.index {
            let at = self.message_seeds.iter().position(|(i, _)| *i == iteration);
            return at
                .map(|at| self.message_seeds.remove(at).1)
                .ok_or(Error::DuplicatedMessage(iteration));
        }
        let jump = iteration - self.chain.index;
        if jump > MAX_JUMP {
            return Err(Error::TooFarAhead(jump));
        }
        while self.chain.index < iteration {
            self.message_seeds
                .push((self.chain.index, self.chain.message_seed()));
            self.chain = self.chain.next();
        }
        if self.message_seeds.len() > MAX_MESSAGE_KEYS {
            let excess = self.message_seeds.len() - MAX_MESSAGE_KEYS;
            self.message_seeds.drain(..excess);
        }
        let seed = self.chain.message_seed();
        self.chain = self.chain.next();
        Ok(seed)
    }
}

/// One sender's keys for one group.
#[derive(Clone, Debug, Default)]
pub struct SenderKeyRecord {
    states: Vec<SenderKeyState>,
}

impl SenderKeyRecord {
    /// The newest state: mine to send with, or the last a sender distributed.
    pub fn state(&self) -> Option<&SenderKeyState> {
        self.states.first()
    }

    pub fn states(&self) -> &[SenderKeyState] {
        &self.states
    }

    /// Adds a state as the newest one, for a storage layer building records.
    pub fn add_state(
        &mut self,
        chain_id: u32,
        chain: ChainKey,
        signing_public: PublicKey,
        signing_private: Option<PrivateKey>,
    ) {
        self.push(SenderKeyState {
            chain_id,
            chain,
            signing_public,
            signing_private,
            message_seeds: Vec::new(),
        });
    }

    /// Moves the newest state's chain forward to `iteration` without keeping
    /// the skipped keys: counters a crash may have used are never reused.
    pub fn fast_forward(&mut self, iteration: u32) -> Result<()> {
        let state = self.states.first_mut().ok_or(Error::NoSenderKey)?;
        let jump = iteration.saturating_sub(state.chain.index);
        if jump > MAX_JUMP {
            return Err(Error::TooFarAhead(jump));
        }
        while state.chain.index < iteration {
            state.chain = state.chain.next();
        }
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.states.is_empty()
    }

    /// My own chain for this group, created on first use: its distribution
    /// message goes to every member before the first group message.
    pub fn distribution<R: CryptoRng + ?Sized>(
        &mut self,
        rng: &mut R,
    ) -> SenderKeyDistributionMessage {
        if !self
            .states
            .first()
            .is_some_and(|s| s.signing_private.is_some())
        {
            let mut seed = [0u8; 32];
            rng.fill_bytes(&mut seed);
            let mut id = [0u8; 4];
            rng.fill_bytes(&mut id);
            self.create(
                u32::from_le_bytes(id) & 0x7fff_ffff,
                seed,
                KeyPair::generate(rng),
            );
        }
        let state = &self.states[0];
        SenderKeyDistributionMessage::new(
            state.chain_id,
            state.chain.index,
            state.chain.key,
            state.signing_public,
        )
    }

    #[doc(hidden)]
    pub fn create(&mut self, chain_id: u32, seed: [u8; 32], signing: KeyPair) {
        self.push(SenderKeyState {
            chain_id,
            chain: ChainKey {
                index: 0,
                key: seed,
            },
            signing_public: signing.public,
            signing_private: Some(signing.private),
            message_seeds: Vec::new(),
        });
    }

    fn push(&mut self, state: SenderKeyState) {
        self.states.insert(0, state);
        self.states.truncate(MAX_STATES);
    }

    /// Another member's distribution message, for their record.
    pub fn process(&mut self, message: &SenderKeyDistributionMessage) {
        if self.states.iter().any(|s| s.chain_id == message.chain_id) {
            return;
        }
        self.push(SenderKeyState {
            chain_id: message.chain_id,
            chain: ChainKey {
                index: message.iteration,
                key: message.chain_key,
            },
            signing_public: message.signing_key,
            signing_private: None,
            message_seeds: Vec::new(),
        });
    }

    pub fn encrypt<R: CryptoRng + ?Sized>(
        &mut self,
        plaintext: &[u8],
        rng: &mut R,
    ) -> Result<Vec<u8>> {
        let state = self
            .states
            .first_mut()
            .filter(|s| s.signing_private.is_some())
            .ok_or(Error::NoSenderKey)?;
        let keys = GroupKeys::derive(&state.chain.message_seed());
        let ciphertext = aes_cbc_encrypt(&keys.cipher_key, &keys.iv, plaintext);
        let signing = state.signing_private.as_ref().expect("checked above");
        let message =
            SenderKeyMessage::new(state.chain_id, state.chain.index, ciphertext, signing, rng);
        state.chain = state.chain.next();
        Ok(message.serialized().to_vec())
    }

    pub fn decrypt(&mut self, bytes: &[u8]) -> Result<Vec<u8>> {
        let message = SenderKeyMessage::deserialize(bytes)?;
        let at = self
            .states
            .iter()
            .position(|s| s.chain_id == message.chain_id)
            .ok_or(Error::NoSenderKey)?;
        let mut state = self.states[at].clone();
        if !message.verify_signature(&state.signing_public) {
            return Err(Error::BadSignature);
        }
        let keys = GroupKeys::derive(&state.take_seed(message.iteration)?);
        let plaintext = aes_cbc_decrypt(&keys.cipher_key, &keys.iv, &message.ciphertext)?;
        self.states[at] = state;
        Ok(plaintext)
    }

    pub fn serialize(&self) -> Vec<u8> {
        let mut w = Writer::default();
        for s in &self.states {
            w.message(1, |m| {
                m.uint(1, s.chain_id.into());
                m.message(2, |c| {
                    c.uint(1, s.chain.index.into());
                    c.bytes(2, &s.chain.key);
                });
                m.message(3, |k| {
                    k.bytes(1, &s.signing_public.serialize());
                    if let Some(private) = &s.signing_private {
                        k.bytes(2, &private.serialize());
                    }
                });
                for (iteration, seed) in &s.message_seeds {
                    m.message(4, |k| {
                        k.uint(1, (*iteration).into());
                        k.bytes(2, seed);
                    });
                }
            });
        }
        w.0
    }

    pub fn deserialize(bytes: &[u8]) -> Result<Self> {
        let mut record = Self::default();
        fields(bytes, |field, value| {
            if field == 1 {
                record.states.push(read_state(value.bytes()?)?);
            }
            Ok(())
        })?;
        Ok(record)
    }
}

fn index_and_key(bytes: &[u8]) -> Result<(u32, [u8; 32])> {
    let (mut index, mut key) = (0, None);
    fields(bytes, |f, v| {
        match f {
            1 => index = v.u32()?,
            2 => {
                key = Some(
                    v.bytes()?
                        .try_into()
                        .map_err(|_| Error::InvalidProtobuf("expected 32 bytes"))?,
                )
            }
            _ => {}
        }
        Ok(())
    })?;
    Ok((index, key.ok_or(Error::InvalidProtobuf("missing key"))?))
}

fn read_state(bytes: &[u8]) -> Result<SenderKeyState> {
    let (mut chain_id, mut chain, mut signing_public, mut signing_private) = (0, None, None, None);
    let mut message_seeds = Vec::new();
    fields(bytes, |field, value| {
        match field {
            1 => chain_id = value.u32()?,
            2 => {
                let (index, key) = index_and_key(value.bytes()?)?;
                chain = Some(ChainKey { index, key });
            }
            3 => fields(value.bytes()?, |f, v| {
                match f {
                    1 => signing_public = Some(PublicKey::deserialize(v.bytes()?)?),
                    2 => signing_private = Some(PrivateKey::deserialize(v.bytes()?)?),
                    _ => {}
                }
                Ok(())
            })?,
            4 => message_seeds.push(index_and_key(value.bytes()?)?),
            _ => {}
        }
        Ok(())
    })?;
    Ok(SenderKeyState {
        chain_id,
        chain: chain.ok_or(Error::InvalidProtobuf("sender chain key"))?,
        signing_public: signing_public.ok_or(Error::InvalidProtobuf("signing key"))?,
        signing_private,
        message_seeds,
    })
}
