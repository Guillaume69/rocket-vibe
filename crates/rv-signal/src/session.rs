//! Pairwise sessions: X3DH to start one (Signal's X3DH specification,
//! revision 1), the Double Ratchet to run it (revision 4, section 3), and the
//! `RecordStructure` of `WAProto.proto` to store it.
//!
//! The caller owns storage: it loads a [`SessionRecord`], calls one of its
//! methods, and stores the record again only when the call succeeded. A
//! failed call leaves the record as it was.

use rand_core::CryptoRng;

use crate::crypto::{aes_cbc_decrypt, aes_cbc_encrypt, hkdf, hmac_sha256};
use crate::curve::{KeyPair, PrivateKey, PublicKey};
use crate::message::{Kind, PreKeySignalMessage, SignalMessage, VERSION};
use crate::proto::{Writer, fields};
use crate::{Error, Result};

/// How far ahead of its chain a message may be.
pub const MAX_JUMP: u32 = 2000;
/// Skipped message keys kept per receiving chain.
pub const MAX_MESSAGE_KEYS: usize = 2000;
/// Receiving chains kept per session.
pub const MAX_RECEIVER_CHAINS: usize = 5;
/// Sessions kept behind the current one.
pub const MAX_PREVIOUS_SESSIONS: usize = 40;

const INFO_TEXT: &[u8] = b"WhisperText";
const INFO_RATCHET: &[u8] = b"WhisperRatchet";
const INFO_MESSAGE_KEYS: &[u8] = b"WhisperMessageKeys";

#[derive(Clone, Debug)]
pub struct MessageKeys {
    pub index: u32,
    pub cipher_key: [u8; 32],
    pub mac_key: [u8; 32],
    pub iv: [u8; 16],
}

impl MessageKeys {
    fn derive(seed: &[u8; 32], index: u32) -> Self {
        let okm: [u8; 80] = hkdf(None, seed, INFO_MESSAGE_KEYS);
        Self {
            index,
            cipher_key: okm[..32].try_into().expect("32"),
            mac_key: okm[32..64].try_into().expect("32"),
            iv: okm[64..].try_into().expect("16"),
        }
    }
}

/// A symmetric chain: KDF_CK is HMAC-SHA256 keyed by the chain key, with the
/// input 0x01 for a message key's seed and 0x02 for the next chain key.
#[derive(Clone, Debug)]
pub struct ChainKey {
    pub index: u32,
    pub key: [u8; 32],
}

impl ChainKey {
    pub(crate) fn message_seed(&self) -> [u8; 32] {
        hmac_sha256(&self.key, &[&[0x01]])
    }

    pub(crate) fn next(&self) -> Self {
        Self {
            index: self.index + 1,
            key: hmac_sha256(&self.key, &[&[0x02]]),
        }
    }

    fn message_keys(&self) -> MessageKeys {
        MessageKeys::derive(&self.message_seed(), self.index)
    }
}

#[derive(Clone, Debug)]
struct Chain {
    ratchet_key: PublicKey,
    ratchet_private: Option<PrivateKey>,
    chain_key: ChainKey,
    message_keys: Vec<MessageKeys>,
}

#[derive(Clone, Debug)]
struct PendingPreKey {
    prekey_id: Option<u32>,
    signed_prekey_id: u32,
    base_key: PublicKey,
}

/// KDF_RK: HKDF-SHA256 salted with the root key over the DH output.
fn kdf_rk(root_key: &[u8; 32], dh: &[u8; 32]) -> ([u8; 32], ChainKey) {
    let okm: [u8; 64] = hkdf(Some(root_key), dh, INFO_RATCHET);
    (
        okm[..32].try_into().expect("32"),
        ChainKey {
            index: 0,
            key: okm[32..].try_into().expect("32"),
        },
    )
}

/// The X3DH KDF: 32 0xFF bytes in front of the DH outputs, no salt.
fn kdf_x3dh(dhs: &[[u8; 32]]) -> ([u8; 32], ChainKey) {
    let mut ikm = vec![0xffu8; 32];
    for dh in dhs {
        ikm.extend_from_slice(dh);
    }
    let okm: [u8; 64] = hkdf(None, &ikm, INFO_TEXT);
    (
        okm[..32].try_into().expect("32"),
        ChainKey {
            index: 0,
            key: okm[32..].try_into().expect("32"),
        },
    )
}

#[derive(Clone, Debug)]
pub struct SessionState {
    local_identity: PublicKey,
    remote_identity: PublicKey,
    root_key: [u8; 32],
    previous_counter: u32,
    sender_chain: Option<Chain>,
    receiver_chains: Vec<Chain>,
    pending_prekey: Option<PendingPreKey>,
    remote_registration_id: u32,
    local_registration_id: u32,
    /// The initiator's X3DH base key: the session's name on both sides.
    alice_base_key: Option<PublicKey>,
}

impl SessionState {
    pub fn remote_identity(&self) -> &PublicKey {
        &self.remote_identity
    }

    pub fn remote_registration_id(&self) -> u32 {
        self.remote_registration_id
    }

    fn receiver_chain(&mut self, ratchet_key: &PublicKey) -> Option<&mut Chain> {
        self.receiver_chains
            .iter_mut()
            .find(|c| c.ratchet_key == *ratchet_key)
    }

    /// The first half of the DH ratchet on a new ratchet key from the peer:
    /// its receiving chain, from my current ratchet key. Returns the root key
    /// the second half continues from.
    fn open_receiving_chain(&mut self, their_ratchet: PublicKey) -> Result<[u8; 32]> {
        let ours = self.sender_chain.as_ref().ok_or(Error::NoSession)?;
        let our_private = ours.ratchet_private.as_ref().ok_or(Error::NoSession)?;
        let (root, receiving) = kdf_rk(&self.root_key, &our_private.agree(&their_ratchet)?);
        self.receiver_chains.push(Chain {
            ratchet_key: their_ratchet,
            ratchet_private: None,
            chain_key: receiving,
            message_keys: Vec::new(),
        });
        if self.receiver_chains.len() > MAX_RECEIVER_CHAINS {
            self.receiver_chains.remove(0);
        }
        Ok(root)
    }

    /// The second half, once the message is authenticated: my next ratchet
    /// key and its sending chain. Nothing is drawn for a forged message.
    fn open_sending_chain<R: CryptoRng + ?Sized>(
        &mut self,
        root: [u8; 32],
        their_ratchet: PublicKey,
        rng: &mut R,
    ) -> Result<()> {
        let next = KeyPair::generate(rng);
        let (root, sending) = kdf_rk(&root, &next.private.agree(&their_ratchet)?);
        let sent = self.sender_chain.as_ref().map_or(0, |c| c.chain_key.index);
        // The index of the last message sent on the previous chain, not the
        // spec's count of them: what other implementations put on the wire.
        self.previous_counter = sent.saturating_sub(1);
        self.root_key = root;
        self.sender_chain = Some(Chain {
            ratchet_key: next.public,
            ratchet_private: Some(next.private),
            chain_key: sending,
            message_keys: Vec::new(),
        });
        Ok(())
    }

    /// The message keys for `counter` on the chain of `ratchet_key`, which
    /// must exist: a skipped key is taken out, the chain moves past it.
    fn take_message_keys(&mut self, ratchet_key: &PublicKey, counter: u32) -> Result<MessageKeys> {
        let chain = self.receiver_chain(ratchet_key).ok_or(Error::NoSession)?;
        if counter < chain.chain_key.index {
            let at = chain.message_keys.iter().position(|k| k.index == counter);
            return at
                .map(|at| chain.message_keys.remove(at))
                .ok_or(Error::DuplicatedMessage(counter));
        }
        let jump = counter - chain.chain_key.index;
        if jump > MAX_JUMP {
            return Err(Error::TooFarAhead(jump));
        }
        while chain.chain_key.index < counter {
            chain.message_keys.push(chain.chain_key.message_keys());
            chain.chain_key = chain.chain_key.next();
        }
        if chain.message_keys.len() > MAX_MESSAGE_KEYS {
            let excess = chain.message_keys.len() - MAX_MESSAGE_KEYS;
            chain.message_keys.drain(..excess);
        }
        let keys = chain.chain_key.message_keys();
        chain.chain_key = chain.chain_key.next();
        Ok(keys)
    }

    fn decrypt<R: CryptoRng + ?Sized>(
        &mut self,
        message: &SignalMessage,
        rng: &mut R,
    ) -> Result<Vec<u8>> {
        if self.sender_chain.is_none() {
            return Err(Error::NoSession);
        }
        let ratchet_root = match self.receiver_chain(&message.ratchet_key) {
            Some(_) => None,
            None => Some(self.open_receiving_chain(message.ratchet_key)?),
        };
        let keys = self.take_message_keys(&message.ratchet_key, message.counter)?;
        if !message.verify_mac(&self.remote_identity, &self.local_identity, &keys.mac_key) {
            return Err(Error::BadMac);
        }
        let plaintext = aes_cbc_decrypt(&keys.cipher_key, &keys.iv, &message.ciphertext)?;
        if let Some(root) = ratchet_root {
            self.open_sending_chain(root, message.ratchet_key, rng)?;
        }
        self.pending_prekey = None;
        Ok(plaintext)
    }

    fn encrypt(&mut self, plaintext: &[u8]) -> Result<(Kind, Vec<u8>)> {
        let chain = self.sender_chain.as_mut().ok_or(Error::NoSession)?;
        let keys = chain.chain_key.message_keys();
        let ciphertext = aes_cbc_encrypt(&keys.cipher_key, &keys.iv, plaintext);
        let message = SignalMessage::new(
            &keys.mac_key,
            &self.local_identity,
            &self.remote_identity,
            chain.ratchet_key,
            chain.chain_key.index,
            self.previous_counter,
            ciphertext,
        );
        chain.chain_key = chain.chain_key.next();
        Ok(match &self.pending_prekey {
            Some(pending) => {
                let wrapped = PreKeySignalMessage::new(
                    self.local_registration_id,
                    pending.prekey_id,
                    pending.signed_prekey_id,
                    pending.base_key,
                    self.local_identity,
                    message,
                );
                (Kind::PreKey, wrapped.serialized().to_vec())
            }
            None => (Kind::Whisper, message.serialized().to_vec()),
        })
    }
}

/// What the peer published: its identity, a signed prekey and maybe a
/// one-time prekey.
#[derive(Clone, Debug)]
pub struct PreKeyBundle {
    pub registration_id: u32,
    pub identity: PublicKey,
    pub signed_prekey_id: u32,
    pub signed_prekey: PublicKey,
    pub signed_prekey_signature: [u8; 64],
    pub prekey: Option<(u32, PublicKey)>,
}

/// My long-term keys.
#[derive(Clone, Debug)]
pub struct LocalIdentity {
    pub identity: KeyPair,
    pub registration_id: u32,
}

/// A decrypted pairwise message.
#[derive(Debug)]
pub struct Decrypted {
    pub plaintext: Vec<u8>,
    /// The one-time prekey this message consumed: delete it once the record is stored.
    pub used_prekey: Option<u32>,
}

#[derive(Clone, Debug, Default)]
pub struct SessionRecord {
    current: Option<SessionState>,
    previous: Vec<SessionState>,
}

impl SessionRecord {
    pub fn current(&self) -> Option<&SessionState> {
        self.current.as_ref()
    }

    /// True when a message can be encrypted right away.
    pub fn can_encrypt(&self) -> bool {
        self.current
            .as_ref()
            .is_some_and(|s| s.sender_chain.is_some())
    }

    fn promote(&mut self, state: SessionState) {
        if let Some(old) = self.current.replace(state) {
            self.previous.insert(0, old);
            self.previous.truncate(MAX_PREVIOUS_SESSIONS);
        }
    }

    /// Starts a session from the peer's bundle, as the initiator (Alice): the
    /// messages sent are prekey messages until the peer answers.
    pub fn initiate<R: CryptoRng + ?Sized>(
        &mut self,
        local: &LocalIdentity,
        bundle: &PreKeyBundle,
        rng: &mut R,
    ) -> Result<()> {
        self.initiate_with_base_key(local, bundle, KeyPair::generate(rng), rng)
    }

    #[doc(hidden)]
    pub fn initiate_with_base_key<R: CryptoRng + ?Sized>(
        &mut self,
        local: &LocalIdentity,
        bundle: &PreKeyBundle,
        base: KeyPair,
        rng: &mut R,
    ) -> Result<()> {
        if !bundle.identity.verify(
            &bundle.signed_prekey.serialize(),
            &bundle.signed_prekey_signature,
        ) {
            return Err(Error::BadSignature);
        }
        let mut dhs = vec![
            local.identity.private.agree(&bundle.signed_prekey)?,
            base.private.agree(&bundle.identity)?,
            base.private.agree(&bundle.signed_prekey)?,
        ];
        if let Some((_, prekey)) = &bundle.prekey {
            dhs.push(base.private.agree(prekey)?);
        }
        let (root, receiving) = kdf_x3dh(&dhs);
        let sending_pair = KeyPair::generate(rng);
        let (root, sending) = kdf_rk(&root, &sending_pair.private.agree(&bundle.signed_prekey)?);
        let state = SessionState {
            local_identity: local.identity.public,
            remote_identity: bundle.identity,
            root_key: root,
            previous_counter: 0,
            sender_chain: Some(Chain {
                ratchet_key: sending_pair.public,
                ratchet_private: Some(sending_pair.private),
                chain_key: sending,
                message_keys: Vec::new(),
            }),
            receiver_chains: vec![Chain {
                ratchet_key: bundle.signed_prekey,
                ratchet_private: None,
                chain_key: receiving,
                message_keys: Vec::new(),
            }],
            pending_prekey: Some(PendingPreKey {
                prekey_id: bundle.prekey.map(|(id, _)| id),
                signed_prekey_id: bundle.signed_prekey_id,
                base_key: base.public,
            }),
            remote_registration_id: bundle.registration_id,
            local_registration_id: local.registration_id,
            alice_base_key: Some(base.public),
        };
        self.promote(state);
        Ok(())
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<(Kind, Vec<u8>)> {
        self.current
            .as_mut()
            .ok_or(Error::NoSession)?
            .encrypt(plaintext)
    }

    /// A `msg`: tried on the current session, then on the previous ones; the
    /// session that decrypts it becomes the current one.
    pub fn decrypt<R: CryptoRng + ?Sized>(&mut self, bytes: &[u8], rng: &mut R) -> Result<Vec<u8>> {
        let message = SignalMessage::deserialize(bytes)?;
        self.decrypt_signal(&message, rng)
    }

    fn decrypt_signal<R: CryptoRng + ?Sized>(
        &mut self,
        message: &SignalMessage,
        rng: &mut R,
    ) -> Result<Vec<u8>> {
        let mut first_error = None;
        if let Some(current) = &self.current {
            let mut state = current.clone();
            match state.decrypt(message, rng) {
                Ok(plaintext) => {
                    self.current = Some(state);
                    return Ok(plaintext);
                }
                Err(e) => first_error = Some(e),
            }
        }
        for at in 0..self.previous.len() {
            let mut state = self.previous[at].clone();
            if let Ok(plaintext) = state.decrypt(message, rng) {
                self.previous.remove(at);
                self.promote(state);
                return Ok(plaintext);
            }
        }
        Err(first_error.unwrap_or(Error::NoSession))
    }

    /// A `pkmsg`, as the responder (Bob). The caller reads the message's
    /// prekey ids first ([`PreKeySignalMessage::deserialize`]) to look up
    /// the matching key pairs, and decides whether to trust its identity key.
    pub fn decrypt_prekey<R: CryptoRng + ?Sized>(
        &mut self,
        message: &PreKeySignalMessage,
        local: &LocalIdentity,
        signed_prekey: Option<&KeyPair>,
        prekey: Option<&KeyPair>,
        rng: &mut R,
    ) -> Result<Decrypted> {
        let known = |s: &SessionState| s.alice_base_key == Some(message.base_key);
        if self.current.as_ref().is_some_and(known) || self.previous.iter().any(known) {
            let plaintext = self.decrypt_signal(&message.message, rng)?;
            return Ok(Decrypted {
                plaintext,
                used_prekey: None,
            });
        }
        let signed_prekey =
            signed_prekey.ok_or(Error::UnknownSignedPreKey(message.signed_prekey_id))?;
        let mut dhs = vec![
            signed_prekey.private.agree(&message.identity_key)?,
            local.identity.private.agree(&message.base_key)?,
            signed_prekey.private.agree(&message.base_key)?,
        ];
        match (message.prekey_id, prekey) {
            (Some(_), Some(prekey)) => dhs.push(prekey.private.agree(&message.base_key)?),
            (Some(id), None) => return Err(Error::UnknownPreKey(id)),
            (None, _) => {}
        }
        let (root, sending) = kdf_x3dh(&dhs);
        let mut state = SessionState {
            local_identity: local.identity.public,
            remote_identity: message.identity_key,
            root_key: root,
            previous_counter: 0,
            sender_chain: Some(Chain {
                ratchet_key: signed_prekey.public,
                ratchet_private: Some(signed_prekey.private.clone()),
                chain_key: sending,
                message_keys: Vec::new(),
            }),
            receiver_chains: Vec::new(),
            pending_prekey: None,
            remote_registration_id: message.registration_id,
            local_registration_id: local.registration_id,
            alice_base_key: Some(message.base_key),
        };
        let plaintext = state.decrypt(&message.message, rng)?;
        self.promote(state);
        Ok(Decrypted {
            plaintext,
            used_prekey: message.prekey_id,
        })
    }

    pub fn serialize(&self) -> Vec<u8> {
        let mut w = Writer::default();
        if let Some(current) = &self.current {
            w.message(1, |m| write_state(m, current));
        }
        for state in &self.previous {
            w.message(2, |m| write_state(m, state));
        }
        w.0
    }

    pub fn deserialize(bytes: &[u8]) -> Result<Self> {
        let mut record = Self::default();
        fields(bytes, |field, value| {
            match field {
                1 => record.current = Some(read_state(value.bytes()?)?),
                2 => record.previous.push(read_state(value.bytes()?)?),
                _ => {}
            }
            Ok(())
        })?;
        Ok(record)
    }
}

fn write_chain(w: &mut Writer, chain: &Chain) {
    w.bytes(1, &chain.ratchet_key.serialize());
    if let Some(private) = &chain.ratchet_private {
        w.bytes(2, &private.serialize());
    }
    w.message(3, |c| {
        c.uint(1, chain.chain_key.index.into());
        c.bytes(2, &chain.chain_key.key);
    });
    for keys in &chain.message_keys {
        w.message(4, |k| {
            k.uint(1, keys.index.into());
            k.bytes(2, &keys.cipher_key);
            k.bytes(3, &keys.mac_key);
            k.bytes(4, &keys.iv);
        });
    }
}

fn write_state(w: &mut Writer, s: &SessionState) {
    w.uint(1, VERSION.into());
    w.bytes(2, &s.local_identity.serialize());
    w.bytes(3, &s.remote_identity.serialize());
    w.bytes(4, &s.root_key);
    w.uint(5, s.previous_counter.into());
    if let Some(chain) = &s.sender_chain {
        w.message(6, |c| write_chain(c, chain));
    }
    for chain in &s.receiver_chains {
        w.message(7, |c| write_chain(c, chain));
    }
    if let Some(pending) = &s.pending_prekey {
        w.message(9, |p| {
            p.opt_uint(1, pending.prekey_id.map(u64::from));
            p.bytes(2, &pending.base_key.serialize());
            p.uint(3, pending.signed_prekey_id.into());
        });
    }
    w.uint(10, s.remote_registration_id.into());
    w.uint(11, s.local_registration_id.into());
    if let Some(base) = &s.alice_base_key {
        w.bytes(13, &base.serialize());
    }
}

fn bytes32(v: &[u8]) -> Result<[u8; 32]> {
    v.try_into()
        .map_err(|_| Error::InvalidProtobuf("expected 32 bytes"))
}

fn read_chain(bytes: &[u8]) -> Result<Chain> {
    let (mut ratchet_key, mut ratchet_private, mut chain_key, mut message_keys) =
        (None, None, None, Vec::new());
    fields(bytes, |field, value| {
        match field {
            1 => ratchet_key = Some(PublicKey::deserialize(value.bytes()?)?),
            2 => ratchet_private = Some(PrivateKey::deserialize(value.bytes()?)?),
            3 => {
                let (mut index, mut key) = (0, None);
                fields(value.bytes()?, |f, v| {
                    match f {
                        1 => index = v.u32()?,
                        2 => key = Some(bytes32(v.bytes()?)?),
                        _ => {}
                    }
                    Ok(())
                })?;
                chain_key = Some(ChainKey {
                    index,
                    key: key.ok_or(Error::InvalidProtobuf("chain key"))?,
                });
            }
            4 => {
                let (mut index, mut cipher_key, mut mac_key, mut iv) = (0, None, None, None);
                fields(value.bytes()?, |f, v| {
                    match f {
                        1 => index = v.u32()?,
                        2 => cipher_key = Some(bytes32(v.bytes()?)?),
                        3 => mac_key = Some(bytes32(v.bytes()?)?),
                        4 => {
                            iv = Some(
                                v.bytes()?
                                    .try_into()
                                    .map_err(|_| Error::InvalidProtobuf("iv"))?,
                            )
                        }
                        _ => {}
                    }
                    Ok(())
                })?;
                message_keys.push(MessageKeys {
                    index,
                    cipher_key: cipher_key.ok_or(Error::InvalidProtobuf("cipher key"))?,
                    mac_key: mac_key.ok_or(Error::InvalidProtobuf("mac key"))?,
                    iv: iv.ok_or(Error::InvalidProtobuf("iv"))?,
                });
            }
            _ => {}
        }
        Ok(())
    })?;
    Ok(Chain {
        ratchet_key: ratchet_key.ok_or(Error::InvalidProtobuf("ratchet key"))?,
        ratchet_private,
        chain_key: chain_key.ok_or(Error::InvalidProtobuf("chain key"))?,
        message_keys,
    })
}

fn read_state(bytes: &[u8]) -> Result<SessionState> {
    let mut local_identity = None;
    let mut remote_identity = None;
    let mut root_key = None;
    let mut previous_counter = 0;
    let mut sender_chain = None;
    let mut receiver_chains = Vec::new();
    let mut pending_prekey = None;
    let mut remote_registration_id = 0;
    let mut local_registration_id = 0;
    let mut alice_base_key = None;
    fields(bytes, |field, value| {
        match field {
            1 if value.u32()? != u32::from(VERSION) => {
                return Err(Error::UnsupportedVersion(value.u32()? as u8));
            }
            2 => local_identity = Some(PublicKey::deserialize(value.bytes()?)?),
            3 => remote_identity = Some(PublicKey::deserialize(value.bytes()?)?),
            4 => root_key = Some(bytes32(value.bytes()?)?),
            5 => previous_counter = value.u32()?,
            6 => sender_chain = Some(read_chain(value.bytes()?)?),
            7 => receiver_chains.push(read_chain(value.bytes()?)?),
            9 => {
                let (mut prekey_id, mut base_key, mut signed_prekey_id) = (None, None, 0);
                fields(value.bytes()?, |f, v| {
                    match f {
                        1 => prekey_id = Some(v.u32()?),
                        2 => base_key = Some(PublicKey::deserialize(v.bytes()?)?),
                        3 => signed_prekey_id = v.i32()? as u32,
                        _ => {}
                    }
                    Ok(())
                })?;
                pending_prekey = Some(PendingPreKey {
                    prekey_id,
                    signed_prekey_id,
                    base_key: base_key.ok_or(Error::InvalidProtobuf("pending base key"))?,
                });
            }
            10 => remote_registration_id = value.u32()?,
            11 => local_registration_id = value.u32()?,
            13 => alice_base_key = Some(PublicKey::deserialize(value.bytes()?)?),
            _ => {}
        }
        Ok(())
    })?;
    Ok(SessionState {
        local_identity: local_identity.ok_or(Error::InvalidProtobuf("local identity"))?,
        remote_identity: remote_identity.ok_or(Error::InvalidProtobuf("remote identity"))?,
        root_key: root_key.ok_or(Error::InvalidProtobuf("root key"))?,
        previous_counter,
        sender_chain,
        receiver_chains,
        pending_prekey,
        remote_registration_id,
        local_registration_id,
        alice_base_key,
    })
}
