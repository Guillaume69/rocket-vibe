//! Atomic application ratchets, original ciphertext outbox and protected clear
//! reception. Delivery/journal ordering and app projection belong to adapters.
use super::*;
use openmls::prelude::{ProcessedMessageContent, Sender};
use rv_crypto_public::messages as packet;
use rv_protocol::{SendMessage, cards};
use std::io::Write;
use zeroize::Zeroizing;

const RECORD: &str = "crypto-messages-v1";
const MAX_CACHE: usize = 64;
const MAX_HISTORY: usize = 8192;
const RECORD_LIMIT: usize = 4 * 1024 * 1024;
const PLAIN_LIMIT: usize = 64 * 1024;

#[derive(Clone)]
pub struct MessageObservation {
    pub roster: Roster,
    pub head: Receipt,
    pub needs_rekey: bool,
}
impl MessageObservation {
    pub fn from_wire(
        roster: &rv_protocol::e2ee::GroupRoster,
        state: &rv_protocol::e2ee::GroupState,
    ) -> Result<Self> {
        let change = Change::from_wire(roster, "message-observation", &[], &[])?;
        let head = Receipt::from_state(state)?;
        if head != change.head {
            return Err(Error::Changed);
        }
        Ok(Self {
            roster: change.roster,
            head,
            needs_rekey: state.needs_rekey,
        })
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageSubmission {
    #[serde(with = "bytes")]
    pub proof: Vec<u8>,
    #[serde(with = "bytes")]
    pub ciphertext: Vec<u8>,
}
impl MessageSubmission {
    pub fn verified(&self, now: u64) -> Result<packet::Proof> {
        self.checked_at(now, false)
    }
    pub(super) fn checked_at(&self, now: u64, historical: bool) -> Result<packet::Proof> {
        if self.ciphertext.len() > packet::CIPHERTEXT_LIMIT {
            return Err(Error::Limit);
        }
        let proof = packet::Proof::from_bytes(&self.proof)?;
        if historical {
            proof.authenticate(&self.ciphertext)?;
            if now < proof.certificate.device.issued_at {
                return Err(identity::Error::Expired.into());
            }
        } else {
            proof.verify(now, &self.ciphertext)?;
        }
        Ok(proof)
    }
}
/// Public metadata for the receipt GET, including expired/stale pending sends.
pub struct MessagePending {
    pub header: packet::Header,
    pub fingerprint: Fingerprint,
    pub cancelling: bool,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageCancellation {
    pub header: packet::Header,
    pub fingerprint: Fingerprint,
}
impl MessageCancellation {
    pub fn matches(&self, proof: &packet::Proof) -> Result<()> {
        self.header.validate()?;
        if self.header != proof.header || self.fingerprint != proof.fingerprint()? {
            return Err(Error::Receipt);
        }
        Ok(())
    }
}
pub enum MessageSettlement {
    Accepted(packet::Receipt),
    Cancelled(MessageCancellation),
}
/// Recoverable own document; abandonment never rewinds an MLS generation.
pub struct CancelledMessage {
    pub cancellation: MessageCancellation,
    payload: Zeroizing<Vec<u8>>,
}
impl CancelledMessage {
    pub fn message(&self) -> Result<SendMessage> {
        decode(&self.payload, &self.cancellation.header)
    }
}
/// Only returned after the protected checkpoint. No Debug/Clone/serialization.
pub struct ClearMessage {
    pub receipt: packet::Receipt,
    pub(super) payload: Zeroizing<Vec<u8>>,
}
/// Original own intent retained for compose recovery. A confirmed HTTP receipt
/// remains here until the ordered protected journal has consumed the message.
pub struct OutgoingMessage {
    pub header: packet::Header,
    pub receipt: Option<packet::Receipt>,
    pub cancelling: bool,
    pub cancelled: bool,
    pub observed_at: u64,
    payload: Zeroizing<Vec<u8>>,
}
impl OutgoingMessage {
    pub fn message(&self) -> Result<SendMessage> {
        decode(&self.payload, &self.header)
    }
}
impl ClearMessage {
    pub fn message(&self) -> Result<SendMessage> {
        decode(&self.payload, &self.receipt.header)
    }
}
#[derive(Serialize)]
struct Payload<'a> {
    version: u8,
    message: &'a SendMessage,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnedPayload {
    version: u8,
    message: SendMessage,
}
struct Limited(Zeroizing<Vec<u8>>);
impl Write for Limited {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > PLAIN_LIMIT {
            return Err(std::io::Error::other("crypto_message_limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn validate_message(message: &SendMessage) -> Result<()> {
    if !packet::identifier(&message.operation_id)
        || message.text.len() > 32_768
        || message
            .reply_to
            .as_ref()
            .is_some_and(|s| !packet::identifier(s) || s == &message.operation_id)
        || message.quotes.len() > 8
        || message.cards.len() > cards::MAX_CARDS
    {
        return Err(Error::Limit);
    }
    if message.text.trim().is_empty() && message.quotes.is_empty() && message.cards.is_empty()
        || message.quotes.iter().any(|q| {
            !packet::identifier(&q.room_id)
                || !packet::identifier(&q.message_id)
                || q.revision
                    .parse::<i64>()
                    .ok()
                    .is_none_or(|v| v <= 0 || v.to_string() != q.revision)
        })
        || !cards::validate(&message.cards)
    {
        return Err(Error::Changed);
    }
    Ok(())
}
pub(crate) fn payload(message: &SendMessage) -> Result<Zeroizing<Vec<u8>>> {
    // Bound the serializer before card validation or copying any nested text.
    let mut out = Limited(Zeroizing::new(Vec::new()));
    serde_json::to_writer(
        &mut out,
        &Payload {
            version: 1,
            message,
        },
    )
    .map_err(|_| Error::Limit)?;
    validate_message(message)?;
    Ok(out.0)
}
pub(crate) fn decode(bytes: &[u8], header: &packet::Header) -> Result<SendMessage> {
    if bytes.is_empty() || bytes.len() > PLAIN_LIMIT {
        return Err(Error::Limit);
    }
    let content: OwnedPayload = serde_json::from_slice(bytes).map_err(|_| Error::Changed)?;
    if content.version != 1
        || content.message.operation_id != header.operation
        || content.message.reply_to != header.thread
        || payload(&content.message)?.as_slice() != bytes
    {
        return Err(Error::Changed);
    }
    Ok(content.message)
}
fn operation(user: &str, id: &str) -> Result<String> {
    if !packet::identifier(user) || !packet::identifier(id) {
        return Err(Error::Changed);
    }
    Ok(HEXLOWER.encode(&fingerprint(
        "rocketvibe-message-operation-v1",
        &(user, id),
    )?))
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && HEXLOWER
            .decode(value.as_bytes())
            .is_ok_and(|v| v.len() == 32)
}
fn receipt_hash(receipt: &packet::Receipt) -> Result<String> {
    receipt.validate()?;
    Ok(HEXLOWER.encode(&fingerprint("rocketvibe-message-receipt-v1", receipt)?))
}
fn cancellation(proof: &packet::Proof) -> Result<MessageCancellation> {
    Ok(MessageCancellation {
        header: proof.header.clone(),
        fingerprint: proof.fingerprint()?,
    })
}
fn cancellation_hash(receipt: &MessageCancellation) -> Result<String> {
    receipt.header.validate()?;
    if receipt.fingerprint == [0; 32] {
        return Err(Error::Receipt);
    }
    Ok(HEXLOWER.encode(&fingerprint("rocketvibe-message-cancellation-v1", receipt)?))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Seen {
    packet: String,
    intent: Option<String>,
    receipt: Option<String>,
    #[serde(default)]
    cancelled: Option<String>,
    #[serde(default)]
    cancelling: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    created: u64,
    #[serde(default)]
    historical: bool,
    #[serde(default)]
    retired: bool,
    #[serde(default)]
    journaled: bool,
    submission: MessageSubmission,
    #[serde(with = "secret_bytes")]
    plaintext: Zeroizing<Vec<u8>>,
    grant: Member,
    receipt: Option<packet::Receipt>,
    #[serde(default)]
    archive: Option<vault::blobs::Reference>,
}
impl Entry {
    fn proof(&self) -> Result<packet::Proof> {
        self.submission.checked_at(self.created, self.historical)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    version: u8,
    scope: vault::Scope,
    root: String,
    clock: u64,
    progress: BTreeMap<String, u64>,
    seen: BTreeMap<String, Seen>,
    cache: BTreeMap<String, Entry>,
}
impl Coordinator {
    pub fn outgoing_messages(&self, roster: &Roster, now: u64) -> Result<Vec<OutgoingMessage>> {
        self.inspect(|_, records| {
            let (_, grant) = self.draft_binding(records, roster, &None, now)?;
            let ledger = self.message_ledger(records)?;
            ledger_clock(&ledger, now)?;
            let mut messages = vec![];
            for (id, entry) in &ledger.cache {
                let seen = ledger.seen.get(id).ok_or(Error::Changed)?;
                let header = entry.proof()?.header;
                if seen.intent.is_none()
                    || entry.retired
                    || entry.journaled
                    || entry.grant != grant
                    || header.scope != roster.scope
                    || header.author != self.manager.scope().user
                    || header.device != self.manager.scope().device
                    || HEXLOWER.encode(&header.incarnation) != self.manager.scope().incarnation
                {
                    continue;
                }
                messages.push(OutgoingMessage {
                    header,
                    receipt: entry.receipt.clone(),
                    cancelling: seen.cancelling,
                    cancelled: seen.cancelled.is_some(),
                    observed_at: entry.created,
                    payload: Zeroizing::new(entry.plaintext.to_vec()),
                });
            }
            messages.sort_by(|a, b| {
                (a.observed_at, &a.header.operation).cmp(&(b.observed_at, &b.header.operation))
            });
            Ok(messages)
        })
    }
    fn message_ledger(&self, records: &Records) -> Result<Ledger> {
        let root = HEXLOWER.encode(&self.root.fingerprint()?);
        let Some(value) = records.get(RECORD) else {
            return Ok(Ledger {
                version: 1,
                scope: self.manager.scope().clone(),
                root,
                clock: 0,
                progress: BTreeMap::new(),
                seen: BTreeMap::new(),
                cache: BTreeMap::new(),
            });
        };
        if value.len() > RECORD_LIMIT {
            return Err(Error::Limit);
        }
        let ledger: Ledger = serde_json::from_slice(value).map_err(|_| Error::Changed)?;
        if ledger.version != 1
            || ledger.scope != *self.manager.scope()
            || ledger.root != root
            || ledger.clock > 253_402_300_799
            || ledger.cache.len() > MAX_CACHE
            || ledger.seen.len() > MAX_HISTORY
            || ledger.progress.len() > 1024
        {
            return Err(Error::Changed);
        }
        for (id, seen) in &ledger.seen {
            if !valid_hash(id)
                || !valid_hash(&seen.packet)
                || seen.intent.as_ref().is_some_and(|s| !valid_hash(s))
                || seen.receipt.as_ref().is_some_and(|s| !valid_hash(s))
                || seen.cancelled.as_ref().is_some_and(|s| !valid_hash(s))
                || seen.cancelled.is_some() && (seen.intent.is_none() || seen.receipt.is_some())
                || seen.cancelling
                    && (seen.intent.is_none() || seen.receipt.is_some() || seen.cancelled.is_some())
                || seen.receipt.is_none()
                    && seen.cancelled.is_none()
                    && (seen.intent.is_none() || !ledger.cache.contains_key(id))
            {
                return Err(Error::Changed);
            }
        }
        if ledger
            .progress
            .iter()
            .any(|(id, position)| !valid_hash(id) || *position == 0 || *position > i64::MAX as u64)
        {
            return Err(Error::Changed);
        }
        for (id, entry) in &ledger.cache {
            let seen = ledger.seen.get(id).ok_or(Error::Changed)?;
            let proof = entry.proof()?;
            let header = &proof.header;
            self.scope(&header.scope)?;
            if entry.created > ledger.clock
                || entry.grant.user != ledger.scope.user
                || !packet::identifier(&entry.grant.access_version)
                || !packet::identifier(&entry.grant.activation_version)
                || operation(&header.author, &header.operation)? != *id
                || HEXLOWER.encode(&proof.fingerprint()?) != seen.packet
                || seen.intent.is_none() && entry.receipt.is_none()
                || entry.retired && seen.receipt.is_none() && seen.cancelled.is_none()
                || seen.intent.is_some()
                    && (entry.historical
                        || header.author != ledger.scope.user
                        || header.device != ledger.scope.device
                        || HEXLOWER.encode(&header.incarnation) != ledger.scope.incarnation)
            {
                return Err(Error::Changed);
            }
            decode(&entry.plaintext, header)?;
            if let Some(expected) = &seen.cancelled
                && cancellation_hash(&cancellation(&proof)?)? != *expected
            {
                return Err(Error::Receipt);
            }
            match (&entry.receipt, &seen.receipt) {
                (Some(receipt), Some(expected)) if receipt_hash(receipt)? == *expected => {
                    receipt.matches(&proof)?
                }
                (None, None) => (),
                _ => return Err(Error::Changed),
            }
        }
        Ok(ledger)
    }
    fn message_observation(
        &self,
        records: &Records,
        observation: &MessageObservation,
        now: u64,
    ) -> Result<(State, Member)> {
        check_request(&observation.roster, "message-control", &[])?;
        self.scope(&observation.roster.scope)?;
        let state = read(records, &observation.roster.scope.room)?.ok_or(Error::NotReady)?;
        check_clock(Some(&state), now)?;
        let active = state.active.as_ref().ok_or(Error::NotReady)?;
        if state.scope != observation.roster.scope
            || active.receipt != observation.head
            || active.transition.plan.members != observation.roster.members
            || active.transition.plan.authority_version != observation.roster.authority_version
        {
            return Err(Error::Changed);
        }
        let grant = observation
            .roster
            .members
            .iter()
            .find(|m| m.user == self.manager.scope().user)
            .ok_or(Error::Changed)?
            .clone();
        Ok((state, grant))
    }
    fn message_source(
        &self,
        provider: &OpenMlsRustCrypto,
        records: &Records,
        state: &State,
        observation: &MessageObservation,
        now: u64,
        ordered_receive: bool,
    ) -> Result<(MlsGroup, Context)> {
        if observation.needs_rekey {
            return Err(Error::Changed);
        }
        if state.pending.is_some() && !ordered_receive {
            return Err(Error::Pending);
        }
        let context = self.context(records, now)?;
        let group = MlsGroup::load(
            provider.storage(),
            &GroupId::from_slice(&state.scope.group_id()?),
        )
        .map_err(|_| Error::Mls)?
        .ok_or(Error::Changed)?;
        if !group.is_active()
            || group.ciphersuite() != SUITE
            || group.pending_commit().is_some() && !ordered_receive
            || group.pending_proposals().next().is_some()
        {
            return Err(Error::Pending);
        }
        let plan = &state
            .active
            .as_ref()
            .ok_or(Error::NotReady)?
            .transition
            .plan;
        check_actual(group.public_group(), plan)?;
        check_participants_with(
            group.public_group(),
            plan,
            &context,
            Verification::at(now, ordered_receive),
        )?;
        Ok((group, context))
    }
    pub fn prepare_message(
        &self,
        observation: &MessageObservation,
        message: &SendMessage,
        now: u64,
    ) -> Result<MessageSubmission> {
        check_request(&observation.roster, "message-control", &[])?;
        observation.head.scope.group_id()?;
        if !packet::identifier(&observation.head.operation) {
            return Err(Error::Changed);
        }
        let plaintext = payload(message)?;
        let intent = HEXLOWER.encode(&fingerprint(
            "rocketvibe-message-intent-v1",
            &(&observation.roster, &observation.head, digest(&plaintext)),
        )?);
        let id = operation(&self.manager.scope().user, &message.operation_id)?;
        self.transact(|provider, records| {
            let (mut state, grant) = self.message_observation(records, observation, now)?;
            let (mut group, context) =
                self.message_source(provider, records, &state, observation, now, false)?;
            let mut ledger = self.message_ledger(records)?;
            ledger_clock(&ledger, now)?;
            if let Some(seen) = ledger.seen.get(&id) {
                if seen.intent.as_deref() != Some(&intent) {
                    return Err(Error::Conflict);
                }
                if seen.receipt.is_some() || seen.cancelled.is_some() {
                    return Err(Error::MessageNotPending);
                }
                if seen.cancelling {
                    return Err(Error::MessageCancelling);
                }
                let entry = ledger.cache.get(&id).ok_or(Error::MessageNotRetained)?;
                current_packet(&entry.proof()?.header, observation, &context)?;
                return Ok(entry.submission.clone());
            }
            capacity(&ledger)?;
            let header = packet::Header {
                version: 1,
                scope: state.scope.clone(),
                operation: message.operation_id.clone(),
                group_revision: observation.head.revision,
                epoch: observation.head.epoch,
                group_fingerprint: observation.head.fingerprint,
                author: context.certificate.device.root.user.clone(),
                device: context.certificate.device.device.clone(),
                incarnation: context.certificate.device.incarnation,
                certificate: context.certificate.fingerprint()?,
                kind: packet::Kind::Chat,
                thread: message.reply_to.clone(),
            };
            group.set_aad(header.aad()?);
            let ciphertext = group
                .create_message(provider, &context.local, &plaintext)
                .map_err(|_| Error::Mls)?
                .to_bytes()
                .map_err(|_| Error::Mls)?;
            let mut proof = packet::Proof {
                header,
                certificate: context.certificate,
                ciphertext: digest(&ciphertext),
                signature: vec![],
            };
            proof.signature = context
                .local
                .sign(&proof.signing_bytes()?)
                .map_err(|_| Error::Mls)?;
            let submission = MessageSubmission {
                proof: proof.to_bytes()?,
                ciphertext,
            };
            submission.verified(now)?;
            ledger.seen.insert(
                id.clone(),
                Seen {
                    packet: HEXLOWER.encode(&proof.fingerprint()?),
                    intent: Some(intent.clone()),
                    receipt: None,
                    cancelled: None,
                    cancelling: false,
                },
            );
            ledger.cache.insert(
                id,
                Entry {
                    created: now,
                    historical: false,
                    retired: false,
                    journaled: false,
                    submission: submission.clone(),
                    plaintext: Zeroizing::new(plaintext.to_vec()),
                    grant,
                    receipt: None,
                    archive: None,
                },
            );
            ledger.clock = now;
            state.clock = now;
            save_ledger(records, &ledger)?;
            save(records, &state)?;
            Ok(submission)
        })
    }
    /// A fresh-current-state UI hint. Sending still repeats the checked
    /// preparation; this read creates no outbox or MLS generation.
    pub fn can_prepare_message(&self, observation: &MessageObservation, now: u64) -> Result<bool> {
        self.inspect(|provider, records| {
            let valid = (|| -> Result<()> {
                let (state, _) = self.message_observation(records, observation, now)?;
                self.message_source(provider, records, &state, observation, now, false)?;
                Ok(())
            })();
            match valid {
                Ok(()) => Ok(true),
                Err(Error::Storage(error)) => Err(Error::Storage(error)),
                Err(_) => Ok(false),
            }
        })
    }
    pub fn retry_message(
        &self,
        observation: &MessageObservation,
        id: &str,
        now: u64,
    ) -> Result<MessageSubmission> {
        let id = operation(&self.manager.scope().user, id)?;
        self.inspect(|provider, records| {
            let (state, _) = self.message_observation(records, observation, now)?;
            let (_, context) =
                self.message_source(provider, records, &state, observation, now, false)?;
            let ledger = self.message_ledger(records)?;
            ledger_clock(&ledger, now)?;
            let seen = ledger.seen.get(&id).ok_or(Error::MessageNotPending)?;
            if seen.intent.is_none() || seen.receipt.is_some() || seen.cancelled.is_some() {
                return Err(Error::MessageNotPending);
            }
            if seen.cancelling {
                return Err(Error::MessageCancelling);
            }
            let entry = ledger.cache.get(&id).ok_or(Error::MessageNotRetained)?;
            let proof = entry.submission.verified(now)?;
            current_packet(&proof.header, observation, &context)?;
            Ok(entry.submission.clone())
        })
    }
    pub fn pending_message(&self, id: &str) -> Result<MessagePending> {
        let id = operation(&self.manager.scope().user, id)?;
        self.inspect(|_, records| {
            let ledger = self.message_ledger(records)?;
            let seen = ledger.seen.get(&id).ok_or(Error::MessageNotPending)?;
            if seen.cancelled.is_some() {
                return Err(Error::MessageCancelled);
            }
            if seen.intent.is_none() || seen.receipt.is_some() || seen.cancelled.is_some() {
                return Err(Error::MessageNotPending);
            }
            let entry = ledger.cache.get(&id).ok_or(Error::MessageNotRetained)?;
            let proof = entry.proof()?;
            Ok(MessagePending {
                fingerprint: proof.fingerprint()?,
                header: proof.header,
                cancelling: seen.cancelling,
            })
        })
    }
    pub fn confirm_message(&self, receipt: &packet::Receipt, now: u64) -> Result<()> {
        let hash = receipt_hash(receipt)?;
        let id = operation(&receipt.header.author, &receipt.header.operation)?;
        self.transact(|_, records| {
            let mut ledger = self.message_ledger(records)?;
            ledger_clock(&ledger, now)?;
            let seen = ledger.seen.get_mut(&id).ok_or(Error::MessageNotPending)?;
            if seen.intent.is_none()
                || seen.cancelled.is_some()
                || receipt.header.author != ledger.scope.user
                || receipt.header.device != ledger.scope.device
                || HEXLOWER.encode(&receipt.header.incarnation) != ledger.scope.incarnation
            {
                return Err(Error::Receipt);
            }
            if let Some(original) = &seen.receipt {
                return if original == &hash {
                    Ok(())
                } else {
                    Err(Error::Receipt)
                };
            }
            let entry = ledger.cache.get_mut(&id).ok_or(Error::MessageNotRetained)?;
            receipt.matches(&entry.proof()?)?;
            seen.receipt = Some(hash.clone());
            seen.cancelling = false;
            entry.receipt = Some(receipt.clone());
            ledger.clock = now;
            save_ledger(records, &ledger)
        })
    }
    /// Original opaque intention for terminal reconciliation, even after expiry,
    /// removal, head changes or an already recorded local settlement. Never sends.
    pub fn settlement_submission(&self, id: &str, now: u64) -> Result<MessageSubmission> {
        let id = operation(&self.manager.scope().user, id)?;
        self.inspect(|_, records| {
            let ledger = self.message_ledger(records)?;
            ledger_clock(&ledger, now)?;
            let seen = ledger.seen.get(&id).ok_or(Error::MessageNotPending)?;
            if seen.intent.is_none() {
                return Err(Error::MessageNotPending);
            }
            Ok(ledger
                .cache
                .get(&id)
                .ok_or(Error::MessageNotRetained)?
                .submission
                .clone())
        })
    }
    /// Checkpoint abandonment intent before HTTP. Restart may only reconcile
    /// cancellation/acceptance, never silently resume publication of this ID.
    pub fn request_cancellation(&self, id: &str, now: u64) -> Result<MessageSubmission> {
        let id = operation(&self.manager.scope().user, id)?;
        self.transact(|_, records| {
            let mut ledger = self.message_ledger(records)?;
            ledger_clock(&ledger, now)?;
            let seen = ledger.seen.get_mut(&id).ok_or(Error::MessageNotPending)?;
            if seen.intent.is_none() {
                return Err(Error::MessageNotPending);
            }
            let submission = ledger
                .cache
                .get(&id)
                .ok_or(Error::MessageNotRetained)?
                .submission
                .clone();
            if seen.receipt.is_none() && seen.cancelled.is_none() {
                seen.cancelling = true;
            }
            ledger.clock = now;
            save_ledger(records, &ledger)?;
            Ok(submission)
        })
    }
    pub fn confirm_cancellation(&self, receipt: &MessageCancellation, now: u64) -> Result<()> {
        let hash = cancellation_hash(receipt)?;
        let id = operation(&receipt.header.author, &receipt.header.operation)?;
        self.transact(|_, records| {
            let mut ledger = self.message_ledger(records)?;
            ledger_clock(&ledger, now)?;
            let seen = ledger.seen.get_mut(&id).ok_or(Error::MessageNotPending)?;
            if seen.intent.is_none()
                || seen.receipt.is_some()
                || receipt.header.author != ledger.scope.user
                || receipt.header.device != ledger.scope.device
                || HEXLOWER.encode(&receipt.header.incarnation) != ledger.scope.incarnation
            {
                return Err(Error::Receipt);
            }
            if let Some(original) = &seen.cancelled {
                return if original == &hash {
                    Ok(())
                } else {
                    Err(Error::Receipt)
                };
            }
            let entry = ledger.cache.get(&id).ok_or(Error::MessageNotRetained)?;
            receipt.matches(&entry.proof()?)?;
            seen.cancelled = Some(hash.clone());
            seen.cancelling = false;
            ledger.clock = now;
            save_ledger(records, &ledger)
        })
    }
    pub fn cancelled_message(&self, id: &str) -> Result<CancelledMessage> {
        let id = operation(&self.manager.scope().user, id)?;
        self.inspect(|_, records| {
            let ledger = self.message_ledger(records)?;
            let seen = ledger.seen.get(&id).ok_or(Error::MessageNotRetained)?;
            let entry = ledger.cache.get(&id).ok_or(Error::MessageNotRetained)?;
            let cancellation = cancellation(&entry.proof()?)?;
            if seen.cancelled.as_ref() != Some(&cancellation_hash(&cancellation)?) {
                return Err(Error::Receipt);
            }
            Ok(CancelledMessage {
                cancellation,
                payload: Zeroizing::new(entry.plaintext.to_vec()),
            })
        })
    }
    /// Release the private cached body only after the caller has recovered it.
    /// The terminal operation tombstone remains and the old ID cannot be reused.
    pub fn forget_cancelled_message(&self, receipt: &MessageCancellation) -> Result<()> {
        let id = operation(&self.manager.scope().user, &receipt.header.operation)?;
        let hash = cancellation_hash(receipt)?;
        self.transact(|_, records| {
            let mut ledger = self.message_ledger(records)?;
            let seen = ledger.seen.get(&id).ok_or(Error::MessageNotRetained)?;
            if seen.cancelled.as_ref() != Some(&hash) {
                return Err(Error::Receipt);
            }
            ledger.cache.remove(&id);
            save_ledger(records, &ledger)
        })
    }
    pub fn receive_message(
        &self,
        observation: &MessageObservation,
        submission: &MessageSubmission,
        receipt: &packet::Receipt,
        now: u64,
    ) -> Result<ClearMessage> {
        self.transact_with_blobs(|provider, records, blobs| {
            if super::journal::started(records, &observation.head.scope)? {
                return Err(Error::JournalOrder);
            }
            self.receive_message_inner(
                provider,
                records,
                blobs,
                observation,
                submission,
                receipt,
                now,
                false,
            )
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub(super) fn receive_message_inner(
        &self,
        provider: &OpenMlsRustCrypto,
        records: &mut Records,
        blobs: &mut vault::blobs::Access<'_>,
        observation: &MessageObservation,
        submission: &MessageSubmission,
        receipt: &packet::Receipt,
        now: u64,
        ordered_receive: bool,
    ) -> Result<ClearMessage> {
        let received_hash = receipt_hash(receipt)?;
        let id = operation(&receipt.header.author, &receipt.header.operation)?;
        let (mut state, grant) = self.message_observation(records, observation, now)?;
        let mut ledger = self.message_ledger(records)?;
        ledger_clock(&ledger, now)?;
        let admission = self.admission_witness(
            &state
                .active
                .as_ref()
                .ok_or(Error::NotReady)?
                .transition
                .plan,
            &grant,
        )?;
        if ordered_receive && !self.has_journal_archive(records, &state.scope, &grant, admission)? {
            // Upgrade only protected, previously journaled cache entries. An
            // accepted own echo alone never proves inclusion in this prefix.
            let mut legacy = ledger
                .cache
                .iter()
                .filter_map(|(id, entry)| {
                    let receipt = entry.receipt.as_ref()?;
                    (entry.journaled
                        && !entry.retired
                        && entry.grant == grant
                        && receipt.header.scope == state.scope)
                        .then_some((receipt.position, id.clone()))
                })
                .collect::<Vec<_>>();
            legacy.sort_by_key(|(position, _)| *position);
            for (_, id) in legacy {
                let entry = ledger.cache.get_mut(&id).ok_or(Error::Changed)?;
                let receipt = entry.receipt.as_ref().ok_or(Error::Changed)?;
                let reference = self.archive_observed(
                    records,
                    blobs,
                    &state,
                    &grant,
                    &entry.submission,
                    receipt,
                    &entry.plaintext,
                    entry.created,
                    entry.archive,
                )?;
                self.index_archive_message(
                    records,
                    blobs,
                    reference,
                    &state.scope,
                    &grant,
                    admission,
                )?;
                entry.archive = Some(reference);
            }
        }
        if let Some(seen) = ledger.seen.get_mut(&id) {
            if seen.cancelled.is_some() {
                return Err(Error::Receipt);
            }
            let entry = ledger.cache.get_mut(&id).ok_or(Error::MessageNotRetained)?;
            if entry.retired {
                return Err(Error::MessageRetired);
            }
            if entry.submission != *submission || entry.grant != grant {
                return Err(Error::Conflict);
            }
            receipt.matches(&entry.proof()?)?;
            if seen
                .receipt
                .as_ref()
                .is_some_and(|old| old != &received_hash)
            {
                return Err(Error::Receipt);
            }
            seen.receipt = Some(received_hash.clone());
            seen.cancelling = false;
            entry.receipt = Some(receipt.clone());
            entry.archive = Some(self.archive_observed(
                records,
                blobs,
                &state,
                &grant,
                submission,
                receipt,
                &entry.plaintext,
                entry.created,
                entry.archive,
            )?);
            if ordered_receive && !entry.journaled {
                self.index_archive_message(
                    records,
                    blobs,
                    entry.archive.ok_or(Error::Changed)?,
                    &state.scope,
                    &grant,
                    admission,
                )?;
            }
            entry.journaled |= ordered_receive;
            let clear = ClearMessage {
                receipt: receipt.clone(),
                payload: Zeroizing::new(entry.plaintext.to_vec()),
            };
            ledger.clock = now;
            advance(&mut ledger, receipt)?;
            state.clock = now;
            save_ledger(records, &ledger)?;
            save(records, &state)?;
            return Ok(clear);
        }
        capacity(&ledger)?;
        let stream = stream(&receipt.header.scope)?;
        if ledger
            .progress
            .get(&stream)
            .is_some_and(|position| receipt.position <= *position)
        {
            return Err(Error::Changed);
        }
        let proof = submission.checked_at(now, ordered_receive)?;
        receipt.matches(&proof)?;
        let (mut group, context) =
            self.message_source(provider, records, &state, observation, now, ordered_receive)?;
        current_head(&proof.header, observation)?;
        // OwnPrivateMessage is explicitly unauthenticated in OpenMLS. Only
        // the byte-identical protected outbox path above may supply an echo.
        if proof.header.device == context.certificate.device.device {
            return Err(Error::Changed);
        }
        let protocol = MlsMessageIn::tls_deserialize_exact(&submission.ciphertext)
            .map_err(|_| Error::Mls)?
            .try_into_protocol_message()
            .map_err(|_| Error::Mls)?;
        let processed = group
            .process_message(provider, protocol)
            .map_err(|_| Error::Mls)?;
        let leaf = match processed.sender() {
            Sender::Member(leaf) => leaf.u32(),
            _ => return Err(Error::Changed),
        };
        let plan = &state
            .active
            .as_ref()
            .ok_or(Error::NotReady)?
            .transition
            .plan;
        let participant = plan
            .participants
            .iter()
            .find(|p| p.leaf == leaf)
            .ok_or(Error::Changed)?;
        let certificate = Certificate::from_credential(processed.credential())?;
        if processed.group_id().as_slice() != state.scope.group_id()?
            || processed.epoch().as_u64() != proof.header.epoch
            || processed.aad() != proof.header.aad()?
            || certificate != proof.certificate
            || participant.device != proof.header.device
            || participant.user != proof.header.author
            || participant.incarnation != proof.header.incarnation
            || participant.certificate != proof.header.certificate
        {
            return Err(Error::Changed);
        }
        let plaintext = match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(message) => {
                Zeroizing::new(message.into_bytes())
            }
            _ => return Err(Error::Changed),
        };
        decode(&plaintext, &proof.header)?;
        let archived = self.archive_observed(
            records, blobs, &state, &grant, submission, receipt, &plaintext, now, None,
        )?;
        if ordered_receive {
            self.index_archive_message(records, blobs, archived, &state.scope, &grant, admission)?;
        }
        let clear = ClearMessage {
            receipt: receipt.clone(),
            payload: Zeroizing::new(plaintext.to_vec()),
        };
        ledger.seen.insert(
            id.clone(),
            Seen {
                packet: HEXLOWER.encode(&proof.fingerprint()?),
                intent: None,
                receipt: Some(received_hash.clone()),
                cancelled: None,
                cancelling: false,
            },
        );
        ledger.cache.insert(
            id,
            Entry {
                created: now,
                historical: ordered_receive,
                retired: false,
                journaled: ordered_receive,
                submission: submission.clone(),
                plaintext,
                grant,
                receipt: Some(receipt.clone()),
                archive: Some(archived),
            },
        );
        ledger.clock = now;
        advance(&mut ledger, receipt)?;
        state.clock = now;
        save_ledger(records, &ledger)?;
        save(records, &state)?;
        Ok(clear)
    }
    pub fn forget_message(&self, receipt: &packet::Receipt) -> Result<()> {
        let id = operation(&receipt.header.author, &receipt.header.operation)?;
        let hash = receipt_hash(receipt)?;
        self.transact(|_, records| {
            let mut ledger = self.message_ledger(records)?;
            let seen = ledger.seen.get(&id).ok_or(Error::MessageNotRetained)?;
            if seen.receipt.as_ref() != Some(&hash) {
                return Err(Error::Receipt);
            }
            ledger.cache.remove(&id);
            save_ledger(records, &ledger)
        })
    }
    /// Last protected received message position in this group's native journal.
    /// The delivery worker must validate complete ordered pages; positions have
    /// gaps for other native events. This number grants no send permission.
    pub fn received_message_position(&self, scope: &Scope) -> Result<u64> {
        self.scope(scope)?;
        let stream = stream(scope)?;
        self.inspect(|_, records| {
            Ok(self
                .message_ledger(records)?
                .progress
                .get(&stream)
                .copied()
                .unwrap_or(0))
        })
    }
    pub(super) fn pending_messages(&self, records: &Records, scope: &Scope) -> Result<bool> {
        let ledger = self.message_ledger(records)?;
        for entry in ledger.cache.values() {
            let header = entry.proof()?.header;
            let id = operation(&header.author, &header.operation)?;
            if entry.receipt.is_none()
                && ledger.seen.get(&id).is_some_and(|s| s.cancelled.is_none())
                && header.scope == *scope
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub(super) fn journal_clear(
        &self,
        records: &Records,
        scope: &Scope,
        grant: &Member,
        positions: &[u64],
    ) -> Result<Vec<ClearMessage>> {
        let ledger = self.message_ledger(records)?;
        let mut messages = Vec::new();
        for position in positions {
            let entry = ledger
                .cache
                .values()
                .find(|entry| {
                    !entry.retired
                        && entry.grant == *grant
                        && entry.receipt.as_ref().is_some_and(|receipt| {
                            receipt.position == *position && receipt.header.scope == *scope
                        })
                })
                .ok_or(Error::MessageNotRetained)?;
            messages.push(ClearMessage {
                receipt: entry.receipt.as_ref().ok_or(Error::Changed)?.clone(),
                payload: Zeroizing::new(entry.plaintext.to_vec()),
            });
        }
        Ok(messages)
    }
    pub(super) fn project_journal(
        &self,
        records: &Records,
        scope: &Scope,
        grant: &Member,
        through: u64,
        query: &super::journal::ProjectionQuery,
    ) -> Result<super::journal::RetainedProjection> {
        let ledger = self.message_ledger(records)?;
        let mut entries = ledger
            .cache
            .values()
            .filter_map(|entry| {
                let receipt = entry.receipt.as_ref()?;
                (!entry.retired
                    && entry.journaled
                    && entry.grant == *grant
                    && receipt.header.scope == *scope
                    && receipt.position <= through)
                    .then_some((receipt.position, entry))
            })
            .collect::<Vec<_>>();
        entries.sort_by_key(|(position, _)| *position);
        if entries.windows(2).any(|pair| pair[0].0 == pair[1].0) {
            return Err(Error::JournalOrder);
        }
        let projected = |entry: &Entry| -> Result<super::journal::ProjectedMessage> {
            Ok(super::journal::ProjectedMessage {
                message: ClearMessage {
                    receipt: entry.receipt.as_ref().ok_or(Error::Changed)?.clone(),
                    payload: Zeroizing::new(entry.plaintext.to_vec()),
                },
                observed_at: entry.created,
            })
        };
        let mut replies = BTreeMap::new();
        let mut root = None;
        for (_, entry) in &entries {
            let receipt = entry.receipt.as_ref().ok_or(Error::Changed)?;
            if let Some(thread) = &receipt.header.thread {
                *replies.entry(thread.clone()).or_insert(0u32) += 1;
            } else if query.thread.as_ref() == Some(&receipt.message) {
                root = Some(projected(entry)?);
            }
        }
        entries.retain(|(position, entry)| {
            query.before.is_none_or(|p| *position < p)
                && entry
                    .receipt
                    .as_ref()
                    .is_some_and(|r| r.header.thread == query.thread)
        });
        let older = entries.len() > query.limit;
        let skip = entries.len().saturating_sub(query.limit);
        let messages = entries
            .into_iter()
            .skip(skip)
            .map(|(_, entry)| projected(entry))
            .collect::<Result<Vec<_>>>()?;
        Ok(super::journal::RetainedProjection {
            messages,
            has_older: older,
            root,
            replies,
        })
    }
    pub(super) fn project_sources(
        &self,
        records: &Records,
        scope: &Scope,
        grant: &Member,
        through: u64,
    ) -> Result<Vec<super::journal::ProjectedMessage>> {
        let ledger = self.message_ledger(records)?;
        let mut messages = ledger
            .cache
            .values()
            .filter(|entry| {
                !entry.retired
                    && entry.journaled
                    && entry.grant == *grant
                    && entry
                        .receipt
                        .as_ref()
                        .is_some_and(|r| r.header.scope == *scope && r.position <= through)
            })
            .map(|entry| {
                Ok(super::journal::ProjectedMessage {
                    message: ClearMessage {
                        receipt: entry.receipt.as_ref().ok_or(Error::Changed)?.clone(),
                        payload: Zeroizing::new(entry.plaintext.to_vec()),
                    },
                    observed_at: entry.created,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        messages.sort_by_key(|entry| entry.message.receipt.position);
        if messages
            .windows(2)
            .any(|pair| pair[0].message.receipt.position == pair[1].message.receipt.position)
        {
            return Err(Error::JournalOrder);
        }
        Ok(messages)
    }
    pub(super) fn retire_message_admission(
        &self,
        records: &mut Records,
        room: &str,
        now: u64,
    ) -> Result<()> {
        let mut ledger = self.message_ledger(records)?;
        ledger_clock(&ledger, now)?;
        for (id, entry) in &mut ledger.cache {
            if entry.proof()?.header.scope.room == room {
                let seen = ledger.seen.get(id).ok_or(Error::Changed)?;
                if seen.receipt.is_none() && seen.cancelled.is_none() {
                    return Err(Error::Pending);
                }
                entry.retired = true;
            }
        }
        ledger.clock = now;
        self.retire_observed_archive(records, room)?;
        save_ledger(records, &ledger)
    }
}
fn current_head(header: &packet::Header, observation: &MessageObservation) -> Result<()> {
    if header.scope != observation.head.scope
        || header.group_revision != observation.head.revision
        || header.epoch != observation.head.epoch
        || header.group_fingerprint != observation.head.fingerprint
    {
        return Err(Error::Changed);
    }
    Ok(())
}
fn current_packet(
    header: &packet::Header,
    observation: &MessageObservation,
    context: &Context,
) -> Result<()> {
    current_head(header, observation)?;
    if header.certificate != context.certificate.fingerprint()?
        || header.author != context.certificate.device.root.user
        || header.device != context.certificate.device.device
        || header.incarnation != context.certificate.device.incarnation
    {
        return Err(Error::Changed);
    }
    Ok(())
}
fn capacity(ledger: &Ledger) -> Result<()> {
    if ledger.cache.len() >= MAX_CACHE || ledger.seen.len() >= MAX_HISTORY {
        return Err(Error::Limit);
    }
    Ok(())
}
fn stream(scope: &Scope) -> Result<String> {
    Ok(HEXLOWER.encode(&digest(&scope.group_id()?)))
}
fn advance(ledger: &mut Ledger, receipt: &packet::Receipt) -> Result<()> {
    let id = stream(&receipt.header.scope)?;
    if !ledger.progress.contains_key(&id) && ledger.progress.len() >= 1024 {
        return Err(Error::Limit);
    }
    let position = ledger.progress.entry(id).or_insert(0);
    *position = (*position).max(receipt.position);
    Ok(())
}
fn ledger_clock(ledger: &Ledger, now: u64) -> Result<()> {
    if now < ledger.clock || now > 253_402_300_799 {
        return Err(Error::Changed);
    }
    Ok(())
}
fn save_ledger(records: &mut Records, ledger: &Ledger) -> Result<()> {
    let value = Zeroizing::new(serde_json::to_vec(ledger).map_err(|_| Error::Changed)?);
    if value.len() > RECORD_LIMIT
        || ledger.cache.len() > MAX_CACHE
        || ledger.seen.len() > MAX_HISTORY
    {
        return Err(Error::Limit);
    }
    records.insert(RECORD.into(), value.to_vec());
    Ok(())
}
pub(super) mod secret_bytes {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        value: &Zeroizing<Vec<u8>>,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        let encoded = Zeroizing::new(B64.encode(value));
        serializer.serialize_str(&encoded)
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Zeroizing<Vec<u8>>, D::Error> {
        let encoded = Zeroizing::new(String::deserialize(deserializer)?);
        if encoded.len() > PLAIN_LIMIT.div_ceil(3) * 4 {
            return Err(serde::de::Error::custom("crypto_message_limit"));
        }
        B64.decode(encoded.as_bytes())
            .map(Zeroizing::new)
            .map_err(|_| serde::de::Error::custom("crypto_message_encoding"))
    }
}
