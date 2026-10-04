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
        if self.ciphertext.len() > packet::CIPHERTEXT_LIMIT {
            return Err(Error::Limit);
        }
        let proof = packet::Proof::from_bytes(&self.proof)?;
        proof.verify(now, &self.ciphertext)?;
        Ok(proof)
    }
}
/// Public metadata for the receipt GET, including expired/stale pending sends.
pub struct MessagePending {
    pub header: packet::Header,
    pub fingerprint: Fingerprint,
}
/// Only returned after the protected checkpoint. No Debug/Clone/serialization.
pub struct ClearMessage {
    pub receipt: packet::Receipt,
    payload: Zeroizing<Vec<u8>>,
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
pub(super) fn payload(message: &SendMessage) -> Result<Zeroizing<Vec<u8>>> {
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
fn decode(bytes: &[u8], header: &packet::Header) -> Result<SendMessage> {
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
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Seen {
    packet: String,
    intent: Option<String>,
    receipt: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    created: u64,
    submission: MessageSubmission,
    #[serde(with = "secret_bytes")]
    plaintext: Zeroizing<Vec<u8>>,
    grant: Member,
    receipt: Option<packet::Receipt>,
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
                || seen.receipt.is_none()
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
            let proof = entry.submission.verified(entry.created)?;
            let header = &proof.header;
            self.scope(&header.scope)?;
            if entry.created > ledger.clock
                || entry.grant.user != ledger.scope.user
                || !packet::identifier(&entry.grant.access_version)
                || !packet::identifier(&entry.grant.activation_version)
                || operation(&header.author, &header.operation)? != *id
                || HEXLOWER.encode(&proof.fingerprint()?) != seen.packet
                || seen.intent.is_none() && entry.receipt.is_none()
                || seen.intent.is_some()
                    && (header.author != ledger.scope.user
                        || header.device != ledger.scope.device
                        || HEXLOWER.encode(&header.incarnation) != ledger.scope.incarnation)
            {
                return Err(Error::Changed);
            }
            decode(&entry.plaintext, header)?;
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
    ) -> Result<(MlsGroup, Context)> {
        if observation.needs_rekey {
            return Err(Error::Changed);
        }
        if state.pending.is_some() {
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
            || group.pending_commit().is_some()
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
        check_participants(group.public_group(), plan, &context, now)?;
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
                self.message_source(provider, records, &state, observation, now)?;
            let mut ledger = self.message_ledger(records)?;
            ledger_clock(&ledger, now)?;
            if let Some(seen) = ledger.seen.get(&id) {
                if seen.intent.as_deref() != Some(&intent) {
                    return Err(Error::Conflict);
                }
                if seen.receipt.is_some() {
                    return Err(Error::MessageNotPending);
                }
                let entry = ledger.cache.get(&id).ok_or(Error::MessageNotRetained)?;
                current_packet(
                    &entry.submission.verified(entry.created)?.header,
                    observation,
                    &context,
                )?;
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
                },
            );
            ledger.cache.insert(
                id,
                Entry {
                    created: now,
                    submission: submission.clone(),
                    plaintext: Zeroizing::new(plaintext.to_vec()),
                    grant,
                    receipt: None,
                },
            );
            ledger.clock = now;
            state.clock = now;
            save_ledger(records, &ledger)?;
            save(records, &state)?;
            Ok(submission)
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
            let (_, context) = self.message_source(provider, records, &state, observation, now)?;
            let ledger = self.message_ledger(records)?;
            ledger_clock(&ledger, now)?;
            let seen = ledger.seen.get(&id).ok_or(Error::MessageNotPending)?;
            if seen.intent.is_none() || seen.receipt.is_some() {
                return Err(Error::MessageNotPending);
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
            if seen.intent.is_none() || seen.receipt.is_some() {
                return Err(Error::MessageNotPending);
            }
            let entry = ledger.cache.get(&id).ok_or(Error::MessageNotRetained)?;
            let proof = entry.submission.verified(entry.created)?;
            Ok(MessagePending {
                fingerprint: proof.fingerprint()?,
                header: proof.header,
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
            receipt.matches(&entry.submission.verified(entry.created)?)?;
            seen.receipt = Some(hash.clone());
            entry.receipt = Some(receipt.clone());
            ledger.clock = now;
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
        let received_hash = receipt_hash(receipt)?;
        let id = operation(&receipt.header.author, &receipt.header.operation)?;
        self.transact(|provider, records| {
            let (mut state, grant) = self.message_observation(records, observation, now)?;
            let mut ledger = self.message_ledger(records)?;
            ledger_clock(&ledger, now)?;
            if let Some(seen) = ledger.seen.get_mut(&id) {
                let entry = ledger.cache.get_mut(&id).ok_or(Error::MessageNotRetained)?;
                if entry.submission != *submission || entry.grant != grant {
                    return Err(Error::Conflict);
                }
                receipt.matches(&submission.verified(entry.created)?)?;
                if seen
                    .receipt
                    .as_ref()
                    .is_some_and(|old| old != &received_hash)
                {
                    return Err(Error::Receipt);
                }
                seen.receipt = Some(received_hash.clone());
                entry.receipt = Some(receipt.clone());
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
            let proof = submission.verified(now)?;
            receipt.matches(&proof)?;
            let (mut group, context) =
                self.message_source(provider, records, &state, observation, now)?;
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
                },
            );
            ledger.cache.insert(
                id,
                Entry {
                    created: now,
                    submission: submission.clone(),
                    plaintext,
                    grant,
                    receipt: Some(receipt.clone()),
                },
            );
            ledger.clock = now;
            advance(&mut ledger, receipt)?;
            state.clock = now;
            save_ledger(records, &ledger)?;
            save(records, &state)?;
            Ok(clear)
        })
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
            if entry.receipt.is_none()
                && entry.submission.verified(entry.created)?.header.scope == *scope
            {
                return Ok(true);
            }
        }
        Ok(false)
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
mod secret_bytes {
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
