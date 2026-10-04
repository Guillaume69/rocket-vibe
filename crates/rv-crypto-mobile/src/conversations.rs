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
    crypto_admission: String,
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
        "position":position,"observed_at":observed.to_string(),"status":status})
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
                let root = projection
                    .root
                    .map(|entry| {
                        let receipt = &entry.message.receipt;
                        Ok::<_, CryptoBridgeError>(row(
                            &receipt.header,
                            entry.message.message()?,
                            receipt.message.clone(),
                            Some(receipt.position.to_string()),
                            entry.observed_at,
                            "journaled",
                        ))
                    })
                    .transpose()?;
                let thread_ready = request.thread.is_none() || root.is_some();
                let mut rows = Vec::new();
                for entry in projection.messages {
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
                if before.is_none() {
                    for entry in c.outgoing_messages(&current.roster, time)? {
                        if entry.header.thread != request.thread {
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
            } => {
                if quotes.len() > 8 || sources.len() > 8 {
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
                    let observed = if r.room_id == current.roster.scope.room {
                        &observation
                    } else {
                        observations
                            .get(&r.room_id)
                            .ok_or(CryptoBridgeError::Integrity)?
                    };
                    let sources = c.journal_sources(observed, time)?;
                    if selection.crypto_admission != HEXLOWER.encode(&sources.admission)
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
                        && v.header.thread == request.thread
                        && v.message()
                            .is_ok_and(|m| m.text == text && m.quotes == refs)
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
                };
                c.prepare_message(current, &message, time)?;
                json!({"operation":operation})
            }
            Command::Restore { operation } => {
                let own = self.own_outgoing(&c, current, &request.thread, &operation, time)?;
                if !own.cancelled
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
                if c.draft(&current.roster, request.thread.clone(), time)?
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
