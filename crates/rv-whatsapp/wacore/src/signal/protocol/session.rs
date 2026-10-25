//! Session records and the counter lease.
//!
//! A sent message's counter fixes its message key and IV, so a counter must
//! never be used twice, even across a crash that loses the record's last
//! writes. Before a counter goes on the wire the record reserves a batch past
//! it (`reserve_sender_chain_counters`), and the reservation is made durable
//! first. A record reloaded by the store instance that wrote it (same
//! incarnation) is exact; any other reload, being a recovery, moves the
//! sending chain to the reserved ceiling, so nothing below it is reused.

use waproto::codec;
use waproto::whatsapp as wa;

use super::consts::{MAX_RESERVATION_FAST_FORWARD, SENDER_CHAIN_RESERVATION_BATCH};
use super::envelope;
use super::error::{InvalidSessionError, Result, SignalProtocolError};
use super::keys::{KeyPair, PublicKey};
use super::prekeys::{PreKeyId, SignedPreKeyId};

#[derive(Clone, Debug)]
pub struct ChainKey(pub(crate) rv_signal::ChainKey);

impl ChainKey {
    pub fn new(key: [u8; 32], index: u32) -> Self {
        Self(rv_signal::ChainKey { index, key })
    }

    pub fn key(&self) -> &[u8; 32] {
        &self.0.key
    }

    pub fn index(&self) -> u32 {
        self.0.index
    }

    pub fn next_chain_key(&self) -> Result<Self> {
        Ok(Self(self.0.next()))
    }

    pub fn message_keys(&self) -> MessageKeyGenerator {
        MessageKeyGenerator(self.0.clone())
    }
}

/// The keys of one chain position, derived on demand.
#[derive(Clone, Debug)]
pub struct MessageKeyGenerator(rv_signal::ChainKey);

impl MessageKeyGenerator {
    pub fn generate_keys(&self) -> MessageKeys {
        MessageKeys(self.0.message_keys())
    }
}

#[derive(Clone, Debug)]
pub struct MessageKeys(rv_signal::MessageKeys);

impl MessageKeys {
    pub fn cipher_key(&self) -> &[u8; 32] {
        &self.0.cipher_key
    }
    pub fn mac_key(&self) -> &[u8; 32] {
        &self.0.mac_key
    }
    pub fn iv(&self) -> &[u8; 16] {
        &self.0.iv
    }
    pub fn counter(&self) -> u32 {
        self.0.index
    }
}

#[derive(Clone, Debug)]
pub struct RootKey([u8; 32]);

impl RootKey {
    pub fn new(key: [u8; 32]) -> Self {
        Self(key)
    }

    pub fn key(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Display for RootKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RootKey(..)")
    }
}

/// What a session still re-sends until the peer answers.
#[derive(Clone, Debug)]
pub struct UnacknowledgedPreKeyMessageItems {
    pre_key_id: Option<PreKeyId>,
    signed_pre_key_id: SignedPreKeyId,
    base_key: PublicKey,
}

impl UnacknowledgedPreKeyMessageItems {
    pub fn pre_key_id(&self) -> Option<PreKeyId> {
        self.pre_key_id
    }

    pub fn signed_pre_key_id(&self) -> SignedPreKeyId {
        self.signed_pre_key_id
    }

    pub fn base_key(&self) -> &PublicKey {
        &self.base_key
    }
}

/// One session, kept as the `SessionStructure` it is stored as: a state may be
/// partial (a test fixture, a migrated row) and is only checked when it
/// encrypts or decrypts.
#[derive(Clone, Debug, Default)]
pub struct SessionState(pub(crate) wa::SessionStructure);

type Chain = wa::session_structure::Chain;

fn chain_key_of(chain: &Chain) -> Option<ChainKey> {
    let ck = chain.chain_key.as_option()?;
    let key: [u8; 32] = ck.key.as_deref()?.try_into().ok()?;
    Some(ChainKey::new(key, ck.index.unwrap_or(0)))
}

fn chain_key_field(
    chain_key: &ChainKey,
) -> buffa::MessageField<wa::session_structure::chain::ChainKey> {
    let mut ck = wa::session_structure::chain::ChainKey::default();
    ck.index = Some(chain_key.index());
    ck.key = Some(bytes::Bytes::copy_from_slice(chain_key.key()));
    buffa::MessageField::some(ck)
}

impl SessionState {
    pub fn new(
        version: u8,
        our_identity: &PublicKey,
        their_identity: &PublicKey,
        root_key: &RootKey,
        alice_base_key: &PublicKey,
    ) -> Self {
        let mut s = wa::SessionStructure::default();
        s.session_version = Some(u32::from(version));
        s.local_identity_public = Some(our_identity.serialize().to_vec());
        s.remote_identity_public = Some(their_identity.serialize().to_vec());
        s.root_key = Some(root_key.0.to_vec());
        s.alice_base_key = Some(alice_base_key.serialize().to_vec());
        Self(s)
    }

    pub fn from_session_structure(session: wa::SessionStructure) -> Self {
        Self(session)
    }

    pub fn structure(&self) -> &wa::SessionStructure {
        &self.0
    }

    pub fn alice_base_key(&self) -> &[u8] {
        self.0.alice_base_key.as_deref().unwrap_or_default()
    }

    pub fn remote_identity_key(
        &self,
    ) -> std::result::Result<Option<PublicKey>, InvalidSessionError> {
        match self.0.remote_identity_public.as_deref() {
            None | Some([]) => Ok(None),
            Some(bytes) => PublicKey::deserialize(bytes)
                .map(Some)
                .map_err(|_| InvalidSessionError("bad remote identity key")),
        }
    }

    pub fn local_identity_key(&self) -> std::result::Result<PublicKey, InvalidSessionError> {
        PublicKey::deserialize(self.0.local_identity_public.as_deref().unwrap_or_default())
            .map_err(|_| InvalidSessionError("bad local identity key"))
    }

    pub fn remote_registration_id(&self) -> u32 {
        self.0.remote_registration_id.unwrap_or(0)
    }

    pub fn local_registration_id(&self) -> u32 {
        self.0.local_registration_id.unwrap_or(0)
    }

    pub fn get_sender_chain_key(&self) -> std::result::Result<ChainKey, InvalidSessionError> {
        self.0
            .sender_chain
            .as_option()
            .and_then(chain_key_of)
            .ok_or(InvalidSessionError("no sender chain"))
    }

    pub fn set_sender_chain(&mut self, sender: &KeyPair, next_chain_key: &ChainKey) {
        let mut chain = Chain::default();
        chain.sender_ratchet_key = Some(sender.public.serialize().to_vec());
        chain.sender_ratchet_key_private = Some(sender.private.serialize().to_vec());
        chain.chain_key = chain_key_field(next_chain_key);
        self.0.sender_chain = buffa::MessageField::some(chain);
    }

    pub fn set_sender_chain_key(
        &mut self,
        next_chain_key: &ChainKey,
    ) -> std::result::Result<(), InvalidSessionError> {
        let chain = self
            .0
            .sender_chain
            .as_option_mut()
            .ok_or(InvalidSessionError("no sender chain"))?;
        chain.chain_key = chain_key_field(next_chain_key);
        Ok(())
    }

    pub fn has_usable_sender_chain(&self) -> bool {
        self.get_sender_chain_key().is_ok()
    }

    pub fn unacknowledged_pre_key_message_items(
        &self,
    ) -> std::result::Result<Option<UnacknowledgedPreKeyMessageItems>, InvalidSessionError> {
        let Some(pending) = self.0.pending_pre_key.as_option() else {
            return Ok(None);
        };
        let base_key = PublicKey::deserialize(pending.base_key.as_deref().unwrap_or_default())
            .map_err(|_| InvalidSessionError("bad pending base key"))?;
        Ok(Some(UnacknowledgedPreKeyMessageItems {
            pre_key_id: pending.pre_key_id.map(PreKeyId::from),
            signed_pre_key_id: (pending.signed_pre_key_id.unwrap_or(0) as u32).into(),
            base_key,
        }))
    }

    pub fn clear_unacknowledged_pre_key_message(&mut self) {
        self.0.pending_pre_key = buffa::MessageField::none();
    }

    pub fn sender_ratchet_key_for_logging(
        &self,
    ) -> std::result::Result<String, InvalidSessionError> {
        self.0
            .sender_chain
            .as_option()
            .and_then(|c| c.sender_ratchet_key.as_deref())
            .map(|k| k.iter().map(|b| format!("{b:02x}")).collect())
            .ok_or(InvalidSessionError("no sender chain"))
    }
}

impl From<wa::SessionStructure> for SessionState {
    fn from(session: wa::SessionStructure) -> Self {
        Self(session)
    }
}

/// A pairwise session record: the current state, the ones before it, and the
/// counter lease.
#[derive(Clone, Debug, Default)]
pub struct SessionRecord {
    current: Option<SessionState>,
    previous: Vec<SessionState>,
    /// The first sending counter the durable lease does not cover; 0 for none.
    lease: u32,
    /// The lease was raised and has not reached storage yet.
    pending_reservation: bool,
}

impl SessionRecord {
    pub fn new(state: SessionState) -> Self {
        Self {
            current: Some(state),
            ..Self::default()
        }
    }

    /// An empty record, a session yet to be started.
    pub fn new_fresh() -> Self {
        Self::default()
    }

    pub fn session_state(&self) -> Option<&SessionState> {
        self.current.as_ref()
    }

    pub fn session_state_mut(&mut self) -> Option<&mut SessionState> {
        self.current.as_mut()
    }

    pub fn previous_session_count(&self) -> usize {
        self.previous.len()
    }

    pub fn previous_session_states(
        &self,
    ) -> impl ExactSizeIterator<Item = std::result::Result<SessionState, InvalidSessionError>> + '_
    {
        self.previous.iter().cloned().map(Ok)
    }

    pub fn alice_base_key(&self) -> Result<&[u8]> {
        Ok(self
            .current
            .as_ref()
            .ok_or_else(|| {
                SignalProtocolError::InvalidState("alice_base_key", "no session".to_owned())
            })?
            .alice_base_key())
    }

    pub fn remote_registration_id(&self) -> Result<u32> {
        self.current
            .as_ref()
            .map(SessionState::remote_registration_id)
            .ok_or_else(|| {
                SignalProtocolError::InvalidState("remote_registration_id", "no session".to_owned())
            })
    }

    fn structure(&self) -> wa::RecordStructure {
        let mut r = wa::RecordStructure::default();
        if let Some(current) = &self.current {
            r.current_session = buffa::MessageField::some(current.0.clone());
        }
        r.previous_sessions = self.previous.iter().map(|s| s.0.clone()).collect();
        r
    }

    fn set_structure(&mut self, r: wa::RecordStructure) {
        self.current = r.current_session.into_option().map(SessionState);
        self.previous = r.previous_sessions.into_iter().map(SessionState).collect();
    }

    /// Runs `f` on the `rv-signal` record these states make. A state that
    /// cannot run (missing keys) is an invalid session; a failed `f` leaves the
    /// record as it was.
    pub(crate) fn with_signal<T>(
        &mut self,
        f: impl FnOnce(&mut rv_signal::SessionRecord) -> std::result::Result<T, rv_signal::Error>,
    ) -> std::result::Result<std::result::Result<T, rv_signal::Error>, SignalProtocolError> {
        let mut record = rv_signal::SessionRecord::deserialize(&codec::record_structure_to_vec(
            &self.structure(),
        ))
        .map_err(|_| SignalProtocolError::InvalidSessionStructure("session state cannot run"))?;
        let sending_before = record
            .current()
            .and_then(|s| s.sender_ratchet_key().copied());
        let out = f(&mut record);
        if out.is_ok() {
            let sending_after = record
                .current()
                .and_then(|s| s.sender_ratchet_key().copied());
            let r = codec::record_structure_decode(&record.serialize()).map_err(|_| {
                SignalProtocolError::InvalidSessionStructure("session state did not round-trip")
            })?;
            self.set_structure(r);
            if sending_before.is_some() && sending_after != sending_before {
                self.rebase_lease_after_sender_chain_reset();
            }
        }
        Ok(out)
    }

    /// Covers `spent_counter` with the lease, raising it a batch past it when
    /// it does not; a raised lease must be stored before the counter is sent.
    pub fn reserve_sender_chain_counters(&mut self, spent_counter: u32) {
        if spent_counter >= self.lease {
            self.lease = spent_counter.saturating_add(SENDER_CHAIN_RESERVATION_BATCH);
            self.pending_reservation = true;
        }
    }

    pub fn reserved_sender_chain_index(&self) -> u32 {
        self.lease
    }

    pub fn has_pending_reservation(&self) -> bool {
        self.pending_reservation
    }

    pub fn clear_pending_reservation(&mut self) {
        self.pending_reservation = false;
    }

    pub fn waive_counter_lease(&mut self) {
        self.lease = 0;
        self.pending_reservation = false;
    }

    /// A new sending chain starts its counter at 0: the old ceiling no longer
    /// bounds it, and the next send reserves afresh.
    pub fn rebase_lease_after_sender_chain_reset(&mut self) {
        self.lease = 0;
    }

    pub fn estimated_size(&self) -> usize {
        self.current
            .iter()
            .chain(&self.previous)
            .map(|s| buffa::Message::encoded_len(&s.0) as usize + 3)
            .sum()
    }

    /// The bare `RecordStructure`, written state by state into `out` with no
    /// intermediate copy of the states.
    fn write_record(&self, out: &mut Vec<u8>) {
        if let Some(current) = &self.current {
            out.push(0x0a);
            codec::session_structure_encode_length_delimited(&current.0, out);
        }
        for previous in &self.previous {
            out.push(0x12);
            codec::session_structure_encode_length_delimited(&previous.0, out);
        }
    }

    /// The bare record when there is no lease; the envelope otherwise.
    fn write_stored(&self, out: &mut Vec<u8>, incarnation: Option<&[u8; 16]>) {
        if self.lease == 0 {
            self.write_record(out);
        } else {
            let mut record = Vec::new();
            self.write_record(&mut record);
            envelope::write(out, &record, self.lease, incarnation);
        }
    }

    pub fn serialize(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        self.write_stored(&mut out, None);
        Ok(out)
    }

    /// Bytes from any store: a recovery, so the sending chain moves to the
    /// lease ceiling.
    pub fn deserialize(bytes: &[u8]) -> Result<Self> {
        Self::read(bytes, None)
    }

    pub fn serialize_into_for_store(&self, buf: &mut Vec<u8>, incarnation: &[u8; 16]) {
        self.write_stored(buf, Some(incarnation));
    }

    pub fn serialize_for_store(&self, incarnation: &[u8; 16]) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        self.serialize_into_for_store(&mut out, incarnation);
        Ok(out)
    }

    /// Bytes from this store instance load exactly; any other incarnation's
    /// are a recovery.
    pub fn deserialize_for_store(bytes: &[u8], incarnation: &[u8; 16]) -> Result<Self> {
        Self::read(bytes, Some(incarnation))
    }

    fn read(bytes: &[u8], incarnation: Option<&[u8; 16]>) -> Result<Self> {
        let (record_bytes, lease, exact) = match envelope::read(bytes)? {
            Some(stored) => {
                let exact = incarnation.is_some() && stored.incarnation.as_ref() == incarnation;
                (stored.record, stored.lease, exact)
            }
            None => (bytes, 0, true),
        };
        let structure = codec::record_structure_decode(record_bytes)
            .map_err(|_| SignalProtocolError::InvalidProtobufEncoding)?;
        let mut out = Self {
            lease,
            ..Self::default()
        };
        out.set_structure(structure);
        if !exact {
            out.recover_lease()?;
        }
        Ok(out)
    }

    fn recover_lease(&mut self) -> Result<()> {
        let lease = self.lease;
        let Some(state) = self.current.as_mut() else {
            return Ok(());
        };
        let Ok(chain) = state.get_sender_chain_key() else {
            return Ok(());
        };
        if lease <= chain.index() {
            return Ok(());
        }
        if lease - chain.index() > MAX_RESERVATION_FAST_FORWARD {
            return Err(SignalProtocolError::InvalidSessionStructure(
                "counter lease beyond the fast-forward bound",
            ));
        }
        let mut chain = chain.0;
        while chain.index < lease {
            chain = chain.next();
        }
        state.set_sender_chain_key(&ChainKey(chain))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leased(index: u32) -> SessionRecord {
        let mut rng = rand::rng();
        let local = KeyPair::generate(&mut rng).public;
        let remote = KeyPair::generate(&mut rng).public;
        let base = KeyPair::generate(&mut rng).public;
        let mut state = SessionState::new(3, &local, &remote, &RootKey::new([0; 32]), &base);
        state.set_sender_chain(&KeyPair::generate(&mut rng), &ChainKey::new([1; 32], index));
        SessionRecord::new(state)
    }

    fn index(record: &SessionRecord) -> u32 {
        record
            .session_state()
            .unwrap()
            .get_sender_chain_key()
            .unwrap()
            .index()
    }

    #[test]
    fn the_same_incarnation_reloads_exactly_and_any_other_recovers_to_the_ceiling() {
        let mut record = leased(0);
        record.reserve_sender_chain_counters(0);
        assert_eq!(
            record.reserved_sender_chain_index(),
            SENDER_CHAIN_RESERVATION_BATCH
        );
        assert!(record.has_pending_reservation());
        let stored = record.serialize_for_store(&[1; 16]).unwrap();
        assert_eq!(
            index(&SessionRecord::deserialize_for_store(&stored, &[1; 16]).unwrap()),
            0
        );
        assert_eq!(
            index(&SessionRecord::deserialize_for_store(&stored, &[2; 16]).unwrap()),
            64
        );
        assert_eq!(index(&SessionRecord::deserialize(&stored).unwrap()), 64);
    }

    #[test]
    fn a_lease_is_raised_only_when_a_counter_reaches_it() {
        let mut record = leased(0);
        record.reserve_sender_chain_counters(0);
        record.clear_pending_reservation();
        record.reserve_sender_chain_counters(63);
        assert!(!record.has_pending_reservation());
        record.reserve_sender_chain_counters(64);
        assert!(record.has_pending_reservation());
        assert_eq!(record.reserved_sender_chain_index(), 128);
    }

    #[test]
    fn a_recovery_past_the_fast_forward_bound_is_refused() {
        let mut record = leased(0);
        record.reserve_sender_chain_counters(MAX_RESERVATION_FAST_FORWARD);
        let stored = record.serialize().unwrap();
        assert!(
            SessionRecord::deserialize(&stored)
                .unwrap_err()
                .is_stored_session_corruption()
        );
    }

    #[test]
    fn an_unleased_record_is_stored_bare() {
        let record = leased(5);
        let mut stored = Vec::new();
        record.serialize_into_for_store(&mut stored, &[1; 16]);
        assert_eq!(stored, codec::record_structure_to_vec(&record.structure()));
        assert_eq!(index(&SessionRecord::deserialize(&stored).unwrap()), 5);
    }
}
