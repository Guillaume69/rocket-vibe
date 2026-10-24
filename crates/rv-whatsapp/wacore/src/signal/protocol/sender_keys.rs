//! Sender key records are `rv-signal`'s, kept with the same counter lease as
//! sessions (see `session.rs`): my own chain's iterations are reserved in
//! batches and a recovery moves it to the ceiling.

use super::consts::{MAX_RESERVATION_FAST_FORWARD, SENDER_CHAIN_RESERVATION_BATCH};
use super::envelope;
use super::error::{Result, SignalProtocolError};
use super::keys::{PrivateKey, PublicKey};

pub use rv_signal::{ChainKey as SenderChainKey, SenderKeyState};

#[derive(Clone, Debug, Default)]
pub struct SenderKeyRecord {
    inner: rv_signal::SenderKeyRecord,
    lease: u32,
    wire_gated: bool,
}

impl SenderKeyRecord {
    pub fn new_empty() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }

    /// The newest state: mine to send with, or the last a sender distributed.
    pub fn state(&self) -> Option<&SenderKeyState> {
        self.inner.state()
    }

    pub fn states(&self) -> &[SenderKeyState] {
        self.inner.states()
    }

    /// Adds a state as the newest one.
    pub fn add_state(
        &mut self,
        chain_id: u32,
        chain: SenderChainKey,
        signing_public: PublicKey,
        signing_private: Option<PrivateKey>,
    ) {
        self.inner
            .add_state(chain_id, chain, signing_public, signing_private);
    }

    /// Runs `f` on the `rv-signal` record; a failed `f` leaves this one as it was.
    pub(crate) fn with_signal<T>(
        &mut self,
        f: impl FnOnce(&mut rv_signal::SenderKeyRecord) -> std::result::Result<T, rv_signal::Error>,
    ) -> Result<std::result::Result<T, rv_signal::Error>> {
        let mut record = self.inner.clone();
        let out = f(&mut record);
        if out.is_ok() {
            self.inner = record;
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
        self.inner.serialize().len() + 3 * self.inner.states().len()
    }

    pub fn serialize(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        envelope::write(&mut out, &self.inner.serialize(), self.lease, None);
        Ok(out)
    }

    pub fn deserialize(buf: &[u8]) -> Result<Self> {
        Self::read(buf, None)
    }

    pub fn serialize_for_store(&self, incarnation: &[u8; 16]) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        envelope::write(
            &mut out,
            &self.inner.serialize(),
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
        let inner = rv_signal::SenderKeyRecord::deserialize(record_bytes)
            .map_err(|_| SignalProtocolError::InvalidProtobufEncoding)?;
        let mut out = Self {
            inner,
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
        let Some(state) = self.inner.state() else {
            return Ok(());
        };
        if state.signing_private().is_none() {
            return Ok(());
        }
        let iteration = state.chain_key().index;
        if lease <= iteration {
            return Ok(());
        }
        if lease - iteration > MAX_RESERVATION_FAST_FORWARD {
            return Err(SignalProtocolError::InvalidSenderKeySession);
        }
        self.inner
            .fast_forward(lease)
            .map_err(|_| SignalProtocolError::InvalidSenderKeySession)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use waproto::codec;
    use waproto::whatsapp as wa;

    /// A record as the protobuf structure stored it before the record was
    /// `rv-signal`'s: a newest state of mine with skipped keys, then an older one.
    fn stored_structure(
        mine: &rv_signal::KeyPair,
        theirs: &rv_signal::KeyPair,
    ) -> wa::SenderKeyRecordStructure {
        let state =
            |id: u32, iteration: u32, seed: u8, signing: &rv_signal::KeyPair, private: bool| {
                let mut s = wa::SenderKeyStateStructure::default();
                s.sender_key_id = Some(id);
                let chain = s.sender_chain_key.get_or_insert_default();
                chain.iteration = Some(iteration);
                chain.seed = Some(Bytes::copy_from_slice(&[seed; 32]));
                let key = s.sender_signing_key.get_or_insert_default();
                key.public = Some(Bytes::copy_from_slice(&signing.public.serialize()));
                key.private = private.then(|| Bytes::copy_from_slice(&signing.private.serialize()));
                s
            };
        let mut newest = state(9, 5, 3, mine, true);
        for iteration in [1, 2] {
            let mut skipped = wa::sender_key_state_structure::SenderMessageKey::default();
            skipped.iteration = Some(iteration);
            skipped.seed = Some(Bytes::copy_from_slice(&[iteration as u8; 32]));
            newest.sender_message_keys.push(skipped);
        }
        let mut record = wa::SenderKeyRecordStructure::default();
        record.sender_key_states = vec![newest, state(4, 40, 7, theirs, false)];
        record
    }

    #[test]
    fn a_stored_record_reads_the_same_and_writes_back_the_same_structure() {
        let mut rng = rand::make_rng::<rand::rngs::StdRng>();
        let (mine, theirs) = (
            rv_signal::KeyPair::generate(&mut rng),
            rv_signal::KeyPair::generate(&mut rng),
        );
        let structure = stored_structure(&mine, &theirs);

        let record =
            SenderKeyRecord::deserialize(&codec::sender_key_record_to_vec(&structure)).unwrap();
        let states = record.states();
        assert_eq!(states.len(), 2);
        assert_eq!(states[0].chain_id(), 9);
        assert_eq!(states[0].chain_key().index, 5);
        assert_eq!(states[0].chain_key().key, [3; 32]);
        assert_eq!(*states[0].signing_public(), mine.public);
        assert_eq!(
            states[0].signing_private().map(|k| k.serialize()),
            Some(mine.private.serialize())
        );
        assert_eq!((states[1].chain_id(), states[1].chain_key().index), (4, 40));
        assert!(states[1].signing_private().is_none());

        let written = record.serialize().unwrap();
        let stored = envelope::read(&written).unwrap().expect("an envelope");
        assert_eq!(
            codec::sender_key_record_decode(stored.record).unwrap(),
            structure
        );
    }
}
