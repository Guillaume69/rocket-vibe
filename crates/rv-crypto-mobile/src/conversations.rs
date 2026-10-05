//! Transient render documents only. The journal, drafts, ratchets and original
//! ciphertexts stay in the protected provider; no ordinary SQL participates.
use super::*;
use data_encoding::HEXLOWER;
use rv_crypto::groups as engine;
use rv_protocol::{SendMessage, e2ee as http};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    roster: http::GroupRoster,
    state: http::GroupState,
    thread: Option<String>,
    command: Command,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceObservation {
    roster: http::GroupRoster,
    state: http::GroupState,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QuoteSelection {
    reference: rv_protocol::parity::QuoteReference,
    instance_id: String,
    data_epoch: String,
    membership_version: String,
    crypto_admission: Option<String>,
}
/// The authenticated host adapter rechecks its ordinary, reader-scoped cache
/// immediately before this command. No excerpt or file enters this witness.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicSourceObservation {
    room_id: String,
    membership_version: String,
    references: Vec<rv_protocol::parity::QuoteReference>,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    JournalRequest,
    Receive {
        page: http::DeliveryPage,
    },
    View {
        before: Option<String>,
        limit: u32,
    },
    Sources {
        source: Option<Box<SourceObservation>>,
    },
    SelectQuote {
        message: String,
        membership: String,
    },
    Draft {
        text: Option<String>,
    },
    Prepare {
        text: String,
        #[serde(default)]
        quotes: Vec<QuoteSelection>,
        #[serde(default)]
        sources: Vec<SourceObservation>,
        #[serde(default)]
        public_sources: Vec<PublicSourceObservation>,
        /// Encrypted files sealed by `seal_file` and uploaded (E2EE_FILES.md).
        #[serde(default)]
        files: Vec<rv_protocol::parity::EncryptedFile>,
    },
    /// An edit (`text`) or deletion (no `text`) of an own journaled message.
    Amend {
        target: String,
        text: Option<String>,
    },
    /// A reaction (`present`) to any journaled message, or its withdrawal.
    React {
        target: String,
        emoji: String,
        present: bool,
    },
    /// Private search of this room on the device, threads included.
    Search {
        text: String,
        limit: u32,
    },
    Restore {
        operation: String,
    },
    Pending {
        operation: String,
    },
    Retry {
        operation: String,
    },
    Acknowledge {
        receipt: http::ApplicationReceipt,
    },
    Cancel {
        operation: String,
    },
    Settle {
        operation: String,
        settlement: http::ApplicationSettlement,
    },
}
pub(super) struct Binding {
    scope: String,
    grant: String,
    admission: Option<String>,
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
fn decimal(value: &str) -> Result<u64> {
    let n = value
        .parse::<u64>()
        .map_err(|_| CryptoBridgeError::Integrity)?;
    if value.len() > 19 || n == 0 || n > i64::MAX as u64 || n.to_string() != value {
        return Err(CryptoBridgeError::Integrity);
    }
    Ok(n)
}
fn row(
    header: &rv_crypto_public::messages::Header,
    doc: SendMessage,
    id: String,
    position: Option<String>,
    observed: u64,
    status: &str,
) -> Value {
    json!({"id":id,"operation":header.operation,"author":header.author,"document":doc,
        "position":position,"observed_at":observed.to_string(),"status":status,"edited":false,"amendment":null,
        "reactions":[]})
}
/// A verified row with its author's latest edit and its current reactions.
fn journaled(entry: engine::ProjectedMessage) -> Result<Value> {
    let receipt = &entry.message.receipt;
    let mut value = row(
        &receipt.header,
        entry.message.message()?,
        receipt.message.clone(),
        Some(receipt.position.to_string()),
        entry.observed_at,
        "journaled",
    );
    if let Some(edit) = &entry.edit {
        edited(&mut value, &edit.text);
    }
    value["reactions"] = json!(
        entry
            .reactions
            .iter()
            .map(|r| json!({"emoji":r.emoji,"users":r.users}))
            .collect::<Vec<_>>()
    );
    Ok(value)
}
/// Adds or removes one user's reaction on a rendered row.
fn react_row(row: &mut Value, emoji: &str, user: &str, present: bool) {
    let mut reactions = row["reactions"].as_array().cloned().unwrap_or_default();
    for reaction in reactions.iter_mut().filter(|r| r["emoji"] == emoji) {
        if let Some(users) = reaction["users"].as_array_mut() {
            users.retain(|u| u != user);
            if present {
                users.push(json!(user));
            }
        }
    }
    if present && !reactions.iter().any(|r| r["emoji"] == emoji) {
        reactions.push(json!({"emoji":emoji,"users":[user]}));
    }
    reactions.retain(|r| r["users"].as_array().is_some_and(|u| !u.is_empty()));
    row["reactions"] = json!(reactions);
}
/// The row shows its author's edit; the signed original stays in the journal.
fn edited(row: &mut Value, text: &str) {
    row["document"]["text"] = json!(text);
    row["edited"] = json!(true);
}
fn source_rows(room: &str, sources: engine::JournalSources) -> Result<Value> {
    let admission = HEXLOWER.encode(&sources.admission);
    let mut rows = Vec::new();
    for entry in sources.messages {
        let receipt = &entry.message.receipt;
        rows.push(row(
            &receipt.header,
            entry.message.message()?,
            receipt.message.clone(),
            Some(receipt.position.to_string()),
            entry.observed_at,
            "journaled",
        ));
    }
    Ok(
        json!({"room_id":room,"admission":admission,"after":sources.after.to_string(),"messages":rows}),
    )
}
impl CryptoInstallation {
    fn conversation_binding(
        &self,
        key: &str,
        observation: &engine::MessageObservation,
        admission: Option<String>,
    ) -> Result<()> {
        let scope = serde_json::to_string(&observation.roster.scope)
            .map_err(|_| CryptoBridgeError::Integrity)?;
        let grant = serde_json::to_string(
            &observation
                .roster
                .members
                .iter()
                .find(|m| m.user == self.slot.account().user)
                .ok_or(CryptoBridgeError::Changed)?,
        )
        .map_err(|_| CryptoBridgeError::Integrity)?;
        let mut bindings = self
            .conversation_bindings
            .lock()
            .map_err(|_| CryptoBridgeError::Closed)?;
        if let Some(bound) = bindings.get_mut(key) {
            if bound.scope != scope
                || bound.grant != grant
                || bound
                    .admission
                    .as_ref()
                    .zip(admission.as_ref())
                    .is_some_and(|(a, b)| a != b)
            {
                return Err(CryptoBridgeError::Changed);
            }
            if admission.is_some() {
                bound.admission = admission;
            }
        } else {
            if bindings.len() >= 16 {
                return Err(CryptoBridgeError::Integrity);
            }
            bindings.insert(
                key.into(),
                Binding {
                    scope,
                    grant,
                    admission,
                },
            );
        }
        Ok(())
    }
    fn own_outgoing(
        &self,
        c: &engine::Coordinator,
        observation: &engine::MessageObservation,
        thread: &Option<String>,
        operation: &str,
        time: u64,
    ) -> Result<engine::OutgoingMessage> {
        if !identifier(operation) {
            return Err(CryptoBridgeError::Integrity);
        }
        c.outgoing_messages(&observation.roster, time)?
            .into_iter()
            .find(|v| v.header.operation == operation && &v.header.thread == thread)
            .ok_or(CryptoBridgeError::Changed)
    }
    fn conversation_inner(
        &self,
        manager: Arc<protected::Manager>,
        root: rv_crypto::identity::Root,
        time: u64,
        request: Request,
    ) -> Result<String> {
        groups::roster(&request.roster, &manager, &root)?;
        if request.thread.as_ref().is_some_and(|v| !identifier(v)) {
            return Err(CryptoBridgeError::Integrity);
        }
        let observation = engine::JournalObservation::from_wire(&request.roster, &request.state)?;
        let current = &observation.current;
        let key = serde_json::to_string(&(&request.roster.room_id, &request.thread))
            .map_err(|_| CryptoBridgeError::Integrity)?;
        let c = engine::Coordinator::new(manager.clone(), root.clone())?;
        self.conversation_binding(
            &key,
            current,
            Some(HEXLOWER.encode(&c.current_admission(&current.roster, time)?)),
        )?;
        let value = match request.command {
            Command::JournalRequest => {
                let v = c.journal_request(&request.roster.room_id)?;
                if v.scope != current.roster.scope {
                    return Err(CryptoBridgeError::Changed);
                }
                json!({"after":v.after.to_string(),"through":v.through.map(|v|v.to_string())})
            }
            Command::Receive { page } => {
                c.receive_journal(&observation, &page, time)?;
                Value::Null
            }
            Command::View { before, limit } => {
                let before = before.as_ref().map(|v| decimal(v)).transpose()?;
                let projection = c.journal_projection(
                    &observation,
                    &engine::ProjectionQuery {
                        before,
                        limit: limit as usize,
                        thread: request.thread.clone(),
                    },
                    time,
                )?;
                let admission = HEXLOWER.encode(&projection.admission);
                self.conversation_binding(&key, current, Some(admission.clone()))?;
                let root = projection.root.map(journaled).transpose()?;
                let thread_ready = request.thread.is_none() || root.is_some();
                let mut rows = projection
                    .messages
                    .into_iter()
                    .map(journaled)
                    .collect::<Result<Vec<_>>>()?;
                if before.is_none() {
                    for entry in c.outgoing_messages(&current.roster, time)? {
                        if entry.header.thread != request.thread {
                            continue;
                        }
                        if let Some(target) = &entry.header.target {
                            // An unsettled amendment shows on its target, with
                            // its own operation for retry and cancellation.
                            if entry.cancelled || entry.receipt.is_some() {
                                continue;
                            }
                            let Some(value) = rows.iter_mut().find(|v| v["id"] == **target) else {
                                continue;
                            };
                            let text = entry.message()?.text;
                            match entry.header.kind {
                                engine::MessageKind::Edit => edited(value, &text),
                                engine::MessageKind::React | engine::MessageKind::Unreact => {
                                    let present = entry.header.kind == engine::MessageKind::React;
                                    react_row(value, &text, &entry.header.author, present);
                                }
                                _ => (),
                            }
                            let status = if entry.cancelling {
                                "cancelling"
                            } else {
                                "pending"
                            };
                            value["amendment"] =
                                json!({"operation":entry.header.operation,"status":status});
                            continue;
                        }
                        let status = if entry.cancelled {
                            "cancelled"
                        } else if entry.cancelling {
                            "cancelling"
                        } else if entry.receipt.is_some() {
                            "accepted"
                        } else {
                            "pending"
                        };
                        let id = entry
                            .receipt
                            .as_ref()
                            .map_or_else(|| entry.header.operation.clone(), |v| v.message.clone());
                        let position = entry.receipt.as_ref().map(|v| v.position.to_string());
                        rows.push(row(
                            &entry.header,
                            entry.message()?,
                            id,
                            position,
                            entry.observed_at,
                            status,
                        ));
                    }
                }
                json!({"admission":admission,"after":projection.after.to_string(),"catching_up":!projection.complete,
                    "has_older":projection.has_older,"can_send":thread_ready && c.can_prepare_message(current,time)?,
                    "draft":c.draft(&current.roster,request.thread,time)?.as_str(),"messages":rows,
                    "root":root,"retained_replies":projection.retained_replies})
            }
            Command::Sources { source } => {
                let other = if let Some(source) = source {
                    groups::roster(&source.roster, &manager, &root)?;
                    Some(engine::JournalObservation::from_wire(
                        &source.roster,
                        &source.state,
                    )?)
                } else {
                    None
                };
                let observed = other.as_ref().unwrap_or(&observation);
                match c.journal_sources(observed, time) {
                    Ok(sources) => source_rows(&observed.current.roster.scope.room, sources)?,
                    Err(_) => Value::Null,
                }
            }
            Command::SelectQuote {
                message,
                membership,
            } => {
                if !identifier(&message) || !identifier(&membership) {
                    return Err(CryptoBridgeError::Integrity);
                }
                let sources = c.journal_sources(&observation, time)?;
                let admission = HEXLOWER.encode(&sources.admission);
                let source = sources
                    .messages
                    .into_iter()
                    .find(|m| m.message.receipt.message == message)
                    .ok_or(CryptoBridgeError::Integrity)?;
                let receipt = &source.message.receipt;
                let doc = source.message.message()?;
                json!({"selection":{"reference":{"room_id":current.roster.scope.room,"message_id":message,
                    "revision":receipt.position.to_string()},"instance_id":current.roster.scope.instance,
                    "data_epoch":current.roster.scope.data_epoch,"membership_version":membership,"crypto_admission":admission},
                    "author":receipt.header.author,"text":doc.text.chars().take(1024).collect::<String>()})
            }
            Command::Draft { text } => {
                if let Some(text) = text {
                    c.set_draft(&current.roster, request.thread, text, time)?;
                    Value::Null
                } else {
                    json!(c.draft(&current.roster, request.thread, time)?.as_str())
                }
            }
            Command::Prepare {
                text,
                quotes,
                sources,
                public_sources,
                files,
            } => {
                if quotes.len() > 8 || sources.len() + public_sources.len() > 8 {
                    return Err(CryptoBridgeError::Integrity);
                }
                let mut observations = std::collections::BTreeMap::new();
                for source in sources {
                    groups::roster(&source.roster, &manager, &root)?;
                    let observed =
                        engine::JournalObservation::from_wire(&source.roster, &source.state)?;
                    let room = observed.current.roster.scope.room.clone();
                    if observations.insert(room, observed).is_some() {
                        return Err(CryptoBridgeError::Integrity);
                    }
                }
                let mut public = std::collections::BTreeMap::new();
                for source in public_sources {
                    if !identifier(&source.room_id)
                        || !identifier(&source.membership_version)
                        || source.references.is_empty()
                        || source.references.len() > 8
                        || observations.contains_key(&source.room_id)
                        || c.has_recorded_group(&source.room_id)?
                    {
                        return Err(CryptoBridgeError::Integrity);
                    }
                    let mut seen = std::collections::BTreeSet::new();
                    for r in &source.references {
                        if r.room_id != source.room_id
                            || !identifier(&r.message_id)
                            || !seen.insert(&r.message_id)
                        {
                            return Err(CryptoBridgeError::Integrity);
                        }
                        decimal(&r.revision)?;
                    }
                    if public.insert(source.room_id.clone(), source).is_some() {
                        return Err(CryptoBridgeError::Integrity);
                    }
                }
                let mut refs = Vec::new();
                let mut seen = std::collections::BTreeSet::new();
                for selection in quotes {
                    let r = &selection.reference;
                    if selection.instance_id != current.roster.scope.instance
                        || selection.data_epoch != current.roster.scope.data_epoch
                        || !identifier(&selection.membership_version)
                        || !seen.insert((r.room_id.clone(), r.message_id.clone()))
                    {
                        return Err(CryptoBridgeError::Integrity);
                    }
                    if selection.crypto_admission.is_none() {
                        let source = public.get(&r.room_id).ok_or(CryptoBridgeError::Integrity)?;
                        if source.membership_version != selection.membership_version
                            || !source.references.contains(r)
                        {
                            return Err(CryptoBridgeError::Integrity);
                        }
                        refs.push(selection.reference);
                        continue;
                    }
                    let observed = if r.room_id == current.roster.scope.room {
                        &observation
                    } else {
                        observations
                            .get(&r.room_id)
                            .ok_or(CryptoBridgeError::Integrity)?
                    };
                    let sources = c.journal_sources(observed, time)?;
                    if selection.crypto_admission.as_deref()
                        != Some(HEXLOWER.encode(&sources.admission).as_str())
                        || !sources.messages.iter().any(|m| {
                            m.message.receipt.message == r.message_id
                                && m.message.receipt.position.to_string() == r.revision
                        })
                    {
                        return Err(CryptoBridgeError::Integrity);
                    }
                    refs.push(selection.reference);
                }
                if request.thread.is_some()
                    && c.journal_projection(
                        &observation,
                        &engine::ProjectionQuery {
                            before: None,
                            limit: 1,
                            thread: request.thread.clone(),
                        },
                        time,
                    )?
                    .root
                    .is_none()
                {
                    return Err(CryptoBridgeError::Integrity);
                }
                if c.outgoing_messages(&current.roster, time)?.iter().any(|v| {
                    !v.cancelled
                        && v.header.target.is_none()
                        && v.header.thread == request.thread
                        && v.message()
                            .is_ok_and(|m| m.text == text && m.quotes == refs && m.files == files)
                }) {
                    return Err(CryptoBridgeError::Integrity);
                }
                let mut nonce = [0; 16];
                getrandom::fill(&mut nonce).map_err(|_| CryptoBridgeError::Storage)?;
                let operation = HEXLOWER.encode(&nonce);
                let message = SendMessage {
                    operation_id: operation.clone(),
                    text,
                    reply_to: request.thread,
                    quotes: refs,
                    cards: vec![],
                    files,
                };
                c.prepare_message(current, &message, time)?;
                json!({"operation":operation})
            }
            Command::Amend { target, text } => {
                if !identifier(&target) {
                    return Err(CryptoBridgeError::Integrity);
                }
                let mut nonce = [0; 16];
                getrandom::fill(&mut nonce).map_err(|_| CryptoBridgeError::Storage)?;
                let operation = HEXLOWER.encode(&nonce);
                // The amendment takes its target's thread, whichever view asked.
                c.prepare_amendment(current, &target, text, operation.clone(), time)?;
                json!({"operation":operation})
            }
            Command::React {
                target,
                emoji,
                present,
            } => {
                if !identifier(&target) {
                    return Err(CryptoBridgeError::Integrity);
                }
                let mut nonce = [0; 16];
                getrandom::fill(&mut nonce).map_err(|_| CryptoBridgeError::Storage)?;
                let operation = HEXLOWER.encode(&nonce);
                c.prepare_reaction(current, &target, &emoji, present, operation.clone(), time)?;
                json!({"operation":operation})
            }
            Command::Search { text, limit } => {
                let found = c.journal_search(&observation, &text, limit as usize, time)?;
                let admission = HEXLOWER.encode(&found.admission);
                self.conversation_binding(&key, current, Some(admission.clone()))?;
                let rows = found
                    .messages
                    .into_iter()
                    .map(journaled)
                    .collect::<Result<Vec<_>>>()?;
                json!({"admission":admission,"messages":rows,"truncated":found.truncated})
            }
            Command::Restore { operation } => {
                let own = self.own_outgoing(&c, current, &request.thread, &operation, time)?;
                if own.header.target.is_some()
                    || !own.cancelled
                    || !c
                        .draft(&current.roster, request.thread.clone(), time)?
                        .is_empty()
                {
                    return Err(CryptoBridgeError::Integrity);
                }
                c.set_draft(&current.roster, request.thread, own.message()?.text, time)?;
                Value::Null
            }
            Command::Pending { operation } => {
                let own = self.own_outgoing(&c, current, &request.thread, &operation, time)?;
                if own.cancelled {
                    json!({"operation":operation,"status":"cancelled"})
                } else if own.receipt.is_some() {
                    json!({"operation":operation,"status":"accepted"})
                } else {
                    let pending = c.pending_message(&operation)?;
                    json!({"operation":operation,"status":if pending.cancelling {"cancelling"} else {"pending"}})
                }
            }
            Command::Retry { operation } => {
                self.own_outgoing(&c, current, &request.thread, &operation, time)?;
                json!(c.retry_message(current, &operation, time)?.to_wire()?)
            }
            Command::Acknowledge { receipt } => {
                let ack = engine::wire::message_receipt(&receipt)?;
                let own =
                    self.own_outgoing(&c, current, &request.thread, &ack.header.operation, time)?;
                c.confirm_message(&ack, time)?;
                let sent = own.message()?.text;
                if own.header.target.is_none()
                    && c.draft(&current.roster, request.thread.clone(), time)?
                        .as_str()
                        == sent
                {
                    c.set_draft(&current.roster, request.thread, String::new(), time)?;
                }
                Value::Null
            }
            Command::Cancel { operation } => {
                let own = self.own_outgoing(&c, current, &request.thread, &operation, time)?;
                if own.cancelled {
                    Value::Null
                } else {
                    json!(c.request_cancellation(&operation, time)?.to_wire()?)
                }
            }
            Command::Settle {
                operation,
                settlement,
            } => {
                let own = self.own_outgoing(&c, current, &request.thread, &operation, time)?;
                match settlement {
                    http::ApplicationSettlement::Accepted(receipt) => {
                        let ack = engine::wire::message_receipt(&receipt)?;
                        if ack.header != own.header {
                            return Err(CryptoBridgeError::Changed);
                        }
                        c.confirm_message(&ack, time)?;
                    }
                    http::ApplicationSettlement::Cancelled(receipt) => {
                        let ack = engine::wire::message_cancellation(&receipt)?;
                        if ack.header != own.header {
                            return Err(CryptoBridgeError::Changed);
                        }
                        c.confirm_cancellation(&ack, time)?;
                    }
                }
                Value::Null
            }
        };
        self.check()?;
        let output = serde_json::to_string(&value).map_err(|_| CryptoBridgeError::Integrity)?;
        if output.len() > 8 * 1024 * 1024 {
            return Err(CryptoBridgeError::Integrity);
        }
        Ok(output)
    }
}
#[uniffi::export]
impl CryptoInstallation {
    pub fn conversation_action(&self, directory: String, input: String) -> Result<String> {
        if input.len() > 8 * 1024 * 1024 {
            return Err(CryptoBridgeError::Integrity);
        }
        let request: Request =
            serde_json::from_str(&input).map_err(|_| CryptoBridgeError::Integrity)?;
        let result = self.identity_call(&directory, |account, own, time| {
            let (manager, root) = account.prepared(own, time)?;
            Ok(self.conversation_inner(manager, root, time, request))
        })?;
        if matches!(result, Err(CryptoBridgeError::Changed)) {
            self.stop();
        }
        result
    }
}
