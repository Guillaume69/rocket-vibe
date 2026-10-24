//! Sender key records, kept as `SenderKeyRecordStructure`, with the same
//! counter lease as sessions (see `session.rs`): my own chain's iterations
//! are reserved in batches and a recovery moves it to the ceiling.

use waproto::codec;
use waproto::whatsapp as wa;

use super::consts::{MAX_RESERVATION_FAST_FORWARD, SENDER_CHAIN_RESERVATION_BATCH};
use super::envelope;
use super::error::{InvalidSenderKeySessionError, Result, SignalProtocolError};
use super::keys::{PrivateKey, PublicKey};

const MAX_STATES: usize = 5;

/// A sender chain position.
#[derive(Clone, Debug)]
pub struct SenderChainKey {
    iteration: u32,
    seed: [u8; 32],
}

impl SenderChainKey {
    pub fn iteration(&self) -> u32 {
        self.iteration
    }

    pub fn seed(&self) -> &[u8; 32] {
        &self.seed
    }

    pub fn sender_message_key(&self) -> SenderMessageKey {
        let keys = rv_signal::ChainKey {
            index: self.iteration,
            key: self.seed,
        }
        .group_keys();
        SenderMessageKey {
            iteration: self.iteration,
            cipher_key: keys.cipher_key,
            iv: keys.iv,
        }
    }
}

/// The keys of one group message.
#[derive(Clone, Debug)]
pub struct SenderMessageKey {
    iteration: u32,
    cipher_key: [u8; 32],
    iv: [u8; 16],
}

impl SenderMessageKey {
    pub fn iteration(&self) -> u32 {
        self.iteration
    }
    pub fn cipher_key(&self) -> &[u8] {
        &self.cipher_key
    }
    pub fn iv(&self) -> &[u8] {
        &self.iv
    }
}

#[derive(Clone, Debug)]
pub struct SenderKeyState(wa::SenderKeyStateStructure);

impl SenderKeyState {
    pub fn chain_id(&self) -> u32 {
        self.0.sender_key_id.unwrap_or(0)
    }

    pub fn sender_chain_key(&self) -> Option<SenderChainKey> {
        let ck = self.0.sender_chain_key.as_option()?;
        let seed = ck.seed.as_deref()?.try_into().ok()?;
        Some(SenderChainKey {
            iteration: ck.iteration.unwrap_or(0),
            seed,
        })
    }

    pub fn signing_key_public(
        &self,
    ) -> std::result::Result<PublicKey, InvalidSenderKeySessionError> {
        let key = self
            .0
            .sender_signing_key
            .as_option()
            .and_then(|k| k.public.as_deref())
            .unwrap_or_default();
        PublicKey::deserialize(key).map_err(|_| InvalidSenderKeySessionError("bad signing key"))
    }

    pub fn signing_key_private(
        &self,
    ) -> std::result::Result<Option<PrivateKey>, InvalidSenderKeySessionError> {
        match self
            .0
            .sender_signing_key
            .as_option()
            .and_then(|k| k.private.as_deref())
        {
            None | Some([]) => Ok(None),
            Some(bytes) => PrivateKey::deserialize(bytes)
                .map(Some)
                .map_err(|_| InvalidSenderKeySessionError("bad signing key")),
        }
    }

    fn set_chain(&mut self, iteration: u32, seed: [u8; 32]) {
        let ck = self.0.sender_chain_key.get_or_insert_default();
        ck.iteration = Some(iteration);
        ck.seed = Some(bytes::Bytes::copy_from_slice(&seed));
    }
}

#[derive(Clone, Debug, Default)]
pub struct SenderKeyRecord {
    states: Vec<SenderKeyState>,
    lease: u32,
    wire_gated: bool,
}

impl SenderKeyRecord {
    pub fn new_empty() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.states.is_empty()
    }

    pub fn sender_key_state(
        &self,
    ) -> std::result::Result<&SenderKeyState, InvalidSenderKeySessionError> {
        self.states
            .first()
            .ok_or(InvalidSenderKeySessionError("empty sender key record"))
    }

    pub fn add_sender_key_state(
        &mut self,
        _message_version: u8,
        chain_id: u32,
        iteration: u32,
        chain_key: &[u8],
        signature_key: PublicKey,
        signature_private_key: Option<PrivateKey>,
    ) -> Result<()> {
        let seed: [u8; 32] = chain_key.try_into().map_err(|_| {
            SignalProtocolError::InvalidArgument("chain key must be 32 bytes".to_owned())
        })?;
        let mut s = wa::SenderKeyStateStructure::default();
        s.sender_key_id = Some(chain_id);
        let signing = s.sender_signing_key.get_or_insert_default();
        signing.public = Some(bytes::Bytes::copy_from_slice(&signature_key.serialize()));
        signing.private =
            signature_private_key.map(|k| bytes::Bytes::copy_from_slice(&k.serialize()));
        let mut state = SenderKeyState(s);
        state.set_chain(iteration, seed);
        self.states.insert(0, state);
        self.states.truncate(MAX_STATES);
        Ok(())
    }

    fn structure(&self) -> wa::SenderKeyRecordStructure {
        let mut r = wa::SenderKeyRecordStructure::default();
        r.sender_key_states = self.states.iter().map(|s| s.0.clone()).collect();
        r
    }

    /// Runs `f` on the `rv-signal` record; a failed `f` leaves this one as it was.
    pub(crate) fn with_signal<T>(
        &mut self,
        f: impl FnOnce(&mut rv_signal::SenderKeyRecord) -> std::result::Result<T, rv_signal::Error>,
    ) -> Result<std::result::Result<T, rv_signal::Error>> {
        let mut record = rv_signal::SenderKeyRecord::deserialize(&codec::sender_key_record_to_vec(
            &self.structure(),
        ))
        .map_err(|_| SignalProtocolError::InvalidSenderKeySession)?;
        let out = f(&mut record);
        if out.is_ok() {
            let r = codec::sender_key_record_decode(&record.serialize())
                .map_err(|_| SignalProtocolError::InvalidSenderKeySession)?;
            self.states = r
                .sender_key_states
                .into_iter()
                .map(SenderKeyState)
                .collect();
        }
        Ok(out)
    }

    /// Covers my chain's `spent_iteration` with the lease.
    pub fn reserve_iterations(&mut self, spent_iteration: u32) {
        if spent_iteration >= self.lease {
            self.lease = spent_iteration.saturating_add(SENDER_CHAIN_RESERVATION_BATCH);
            self.wire_gated = true;
        }
    }

    pub fn reserved_iteration(&self) -> u32 {
        self.lease
    }

    pub fn waive_counter_lease(&mut self) -> Result<()> {
        self.lease = 0;
        Ok(())
    }

    /// The record holds a lease that has not reached storage: what is sent
    /// with it must wait for the flush.
    pub fn mark_wire_gated(&mut self) {
        self.wire_gated = true;
    }

    pub fn is_wire_gated(&self) -> bool {
        self.wire_gated
    }

    pub fn clear_wire_gated(&mut self) {
        self.wire_gated = false;
    }

    pub fn estimated_size(&self) -> usize {
        self.states
            .iter()
            .map(|s| buffa::Message::encoded_len(&s.0) as usize + 3)
            .sum()
    }

    pub fn serialize(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        envelope::write(
            &mut out,
            &codec::sender_key_record_to_vec(&self.structure()),
            self.lease,
            None,
        );
        Ok(out)
    }

    pub fn deserialize(buf: &[u8]) -> Result<Self> {
        Self::read(buf, None)
    }

    pub fn serialize_for_store(&self, incarnation: &[u8; 16]) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        envelope::write(
            &mut out,
            &codec::sender_key_record_to_vec(&self.structure()),
            self.lease,
            Some(incarnation),
        );
        Ok(out)
    }

    pub fn deserialize_for_store(buf: &[u8], incarnation: &[u8; 16]) -> Result<Self> {
        Self::read(buf, Some(incarnation))
    }

    fn read(bytes: &[u8], incarnation: Option<&[u8; 16]>) -> Result<Self> {
        let (record_bytes, lease, exact) = match envelope::read(bytes)? {
            Some(stored) => {
                let exact = incarnation.is_some() && stored.incarnation.as_ref() == incarnation;
                (stored.record, stored.lease, exact)
            }
            None => (bytes, 0, true),
        };
        let r = codec::sender_key_record_decode(record_bytes)
            .map_err(|_| SignalProtocolError::InvalidProtobufEncoding)?;
        let mut out = Self {
            states: r
                .sender_key_states
                .into_iter()
                .map(SenderKeyState)
                .collect(),
            lease,
            wire_gated: false,
        };
        if !exact {
            out.recover_lease()?;
        }
        Ok(out)
    }

    /// My own newest chain moves to the lease ceiling.
    fn recover_lease(&mut self) -> Result<()> {
        let lease = self.lease;
        let Some(state) = self.states.first_mut() else {
            return Ok(());
        };
        if !matches!(state.signing_key_private(), Ok(Some(_))) {
            return Ok(());
        }
        let Some(chain) = state.sender_chain_key() else {
            return Ok(());
        };
        if lease <= chain.iteration {
            return Ok(());
        }
        if lease - chain.iteration > MAX_RESERVATION_FAST_FORWARD {
            return Err(SignalProtocolError::InvalidSenderKeySession);
        }
        let mut key = rv_signal::ChainKey {
            index: chain.iteration,
            key: chain.seed,
        };
        while key.index < lease {
            key = key.next();
        }
        state.set_chain(key.index, key.key);
        Ok(())
    }
}
