//! Public delivery DTOs cross Expo; MLS providers, originals and consents stay
//! in the same protected installation used by desktop. No HTTP under its lease.
use super::*;
use data_encoding::HEXLOWER;
use rv_crypto::{groups as engine, identity::Root, packages};
use rv_protocol::e2ee as http;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    View {
        roster: http::GroupRoster,
    },
    Preview {
        roster: http::GroupRoster,
        packages: Vec<http::AvailableKeyPackage>,
        removals: Vec<String>,
        event: Option<http::GroupEvent>,
    },
    Confirm {
        roster: http::GroupRoster,
        id: String,
        fingerprint: String,
    },
    Pending {
        room: String,
    },
    /// The room's voice frame key at the group's current epoch (VOICE.md):
    /// the only group secret that leaves Rust, for LiveKit's frame cryptor.
    VoiceKey {
        room: String,
    },
    Retry {
        room: String,
    },
    Acknowledge {
        room: String,
        receipt: http::GroupReceipt,
    },
    Cancel {
        room: String,
    },
    Settle {
        room: String,
        settlement: http::GroupSettlement,
    },
    Events {
        roster: http::GroupRoster,
        state: http::GroupState,
        page: http::GroupEventPage,
    },
    PackagesPrepare,
    PackagesPending,
    PackagesRetry,
    PackagesAcknowledge {
        receipt: http::OperationReceipt,
    },
}
enum Intent {
    Genesis {
        incarnation: [u8; 16],
        operation: String,
        packages: Vec<http::AvailableKeyPackage>,
    },
    Change {
        operation: String,
        packages: Vec<http::AvailableKeyPackage>,
        removals: Vec<String>,
    },
    Event {
        event: Box<http::GroupEvent>,
        readmission: bool,
    },
}
pub(super) struct Staged {
    id: String,
    room: String,
    consent: engine::Consent,
    intent: Intent,
}
impl From<engine::Error> for CryptoBridgeError {
    fn from(error: engine::Error) -> Self {
        use rv_crypto::identity::Error as Identity;
        match error {
            engine::Error::Storage(error) => error.into(),
            engine::Error::Identity(
                Identity::Untrusted
                | Identity::Unapproved
                | Identity::Revoked
                | Identity::Changed
                | Identity::Expired,
            ) => Self::Untrusted,
            _ => Self::Integrity,
        }
    }
}
impl From<packages::Error> for CryptoBridgeError {
    fn from(error: packages::Error) -> Self {
        match error {
            packages::Error::Storage(error) => error.into(),
            _ => Self::Integrity,
        }
    }
}
fn nonce() -> Result<[u8; 16]> {
    let mut value = [0; 16];
    getrandom::fill(&mut value).map_err(|_| CryptoBridgeError::Storage)?;
    if value == [0; 16] {
        return Err(CryptoBridgeError::Integrity);
    }
    Ok(value)
}
fn public(value: &impl Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|_| CryptoBridgeError::Integrity)
}
fn participants(values: &[engine::Participant]) -> Value {
    Value::Array(
        values
            .iter()
            .map(|v| {
                json!({"user":v.user,"device":v.device,
        "incarnation":HEXLOWER.encode(&v.incarnation),"root":HEXLOWER.encode(&v.root),
        "certificate":HEXLOWER.encode(&v.certificate)})
            })
            .collect(),
    )
}
fn room(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err(CryptoBridgeError::Changed);
    }
    Ok(())
}
pub(super) fn roster(
    value: &http::GroupRoster,
    manager: &protected::Manager,
    root: &Root,
) -> Result<()> {
    room(&value.room_id)?;
    if value.scope.instance_id != manager.scope().instance
        || value.scope.data_epoch != manager.scope().data_epoch
        || !value.members.iter().any(|m| m.user_id == root.user)
    {
        return Err(CryptoBridgeError::Changed);
    }
    // Existing wire conversions also validate ordered unique grants and the head.
    if value.group.is_some() {
        engine::Change::from_wire(value, "observation", &[], &[])?;
    } else {
        engine::Genesis::from_wire(value, [1; 16], "observation", &[])?;
    }
    Ok(())
}
fn pending(c: &engine::Coordinator, room: &str) -> Result<Value> {
    match c.pending_lookup(room) {
        Ok(v) => Ok(
            json!({"operation":v.operation,"fingerprint":HEXLOWER.encode(&v.fingerprint),
            "cancelling":v.cancelling,"superseded":v.superseded}),
        ),
        Err(engine::Error::NotReady) => Ok(Value::Null),
        Err(error) => Err(error.into()),
    }
}
fn settlement(value: &engine::GroupSettlement) -> Result<Value> {
    match value {
        engine::GroupSettlement::Accepted(v) => Ok(json!({"kind":"accepted","data":v.to_wire()?})),
        engine::GroupSettlement::Cancelled(v) => Ok(json!({"kind":"cancelled","data":{
            "scope":{"instance_id":v.scope.instance,"data_epoch":v.scope.data_epoch},"room_id":v.scope.room,
            "incarnation":HEXLOWER.encode(&v.scope.incarnation),"operation_id":v.operation,"device_id":v.device,
            "fingerprint":HEXLOWER.encode(&v.fingerprint)}})),
    }
}
#[uniffi::export]
impl CryptoInstallation {
    /// One bounded public RPC avoids exporting any serializable private consent.
    pub fn group_action(&self, directory: String, input: String) -> Result<String> {
        if input.len() > 8 * 1024 * 1024 {
            return Err(CryptoBridgeError::Integrity);
        }
        let action: Action =
            serde_json::from_str(&input).map_err(|_| CryptoBridgeError::Integrity)?;
        self.identity_call(&directory, |account, own, time| {
            let (manager, root) = account.prepared(own, time)?;
            Ok(self.group_inner(manager, root, account.device_revision()?, time, action))
        })?
    }
}
impl CryptoInstallation {
    fn group_inner(
        &self,
        manager: Arc<protected::Manager>,
        root: Root,
        revision: String,
        time: u64,
        action: Action,
    ) -> Result<String> {
        let c = engine::Coordinator::new(manager.clone(), root.clone())?;
        let value = match action {
            Action::View { roster: wire } => {
                roster(&wire, &manager, &root)?;
                *self
                    .group_preview
                    .lock()
                    .map_err(|_| CryptoBridgeError::Closed)? = None;
                let (accepted, members) = match c.accepted_group(&wire.room_id) {
                    Ok((receipt, members)) => {
                        (public(&receipt.to_wire()?)?, participants(&members))
                    }
                    Err(engine::Error::NotReady) => (Value::Null, json!([])),
                    Err(error) => return Err(error.into()),
                };
                let needs_update =
                    !accepted.is_null() && c.needs_credential_update(&wire.room_id, time)?;
                let grants = if accepted.is_null() {
                    json!([])
                } else {
                    serde_json::to_value(c.accepted_grants(&wire.room_id)?)
                        .map_err(|_| CryptoBridgeError::Integrity)?
                };
                json!({"accepted":accepted,"participants":members,"pending":pending(&c,&wire.room_id)?,
                    "needs_credential_update":needs_update,"grants":grants})
            }
            Action::Preview {
                roster: wire,
                packages,
                removals,
                event,
            } => {
                roster(&wire, &manager, &root)?;
                *self
                    .group_preview
                    .lock()
                    .map_err(|_| CryptoBridgeError::Closed)? = None;
                let (kind, preview, consent, intent) = if let Some(event) = event {
                    if !packages.is_empty() || !removals.is_empty() {
                        return Err(CryptoBridgeError::Integrity);
                    }
                    if event.welcome.is_some() {
                        let admission = engine::Admission::from_wire(&wire, &event)?;
                        let (readmission, preview, consent) =
                            match c.preview_admission(&admission, time) {
                                Ok((p, c)) => (false, p, c),
                                Err(engine::Error::Exists) => {
                                    let (p, c) = c.preview_readmission(&admission, time)?;
                                    (true, p, c)
                                }
                                Err(error) => return Err(error.into()),
                            };
                        (
                            if readmission {
                                "readmission"
                            } else {
                                "admission"
                            },
                            preview,
                            consent,
                            Intent::Event {
                                event: Box::new(event),
                                readmission,
                            },
                        )
                    } else {
                        let (p, c) =
                            c.preview_commit(&engine::Commit::from_wire(&wire, &event)?, time)?;
                        (
                            "commit",
                            p,
                            c,
                            Intent::Event {
                                event: Box::new(event),
                                readmission: false,
                            },
                        )
                    }
                } else if wire.group.is_none() {
                    if !removals.is_empty() {
                        return Err(CryptoBridgeError::Integrity);
                    }
                    let incarnation = nonce()?;
                    let operation = HEXLOWER.encode(&nonce()?);
                    let request =
                        engine::Genesis::from_wire(&wire, incarnation, &operation, &packages)?;
                    let (p, c) = c.preview_genesis(&request, time)?;
                    (
                        "genesis",
                        p,
                        c,
                        Intent::Genesis {
                            incarnation,
                            operation,
                            packages,
                        },
                    )
                } else {
                    let operation = HEXLOWER.encode(&nonce()?);
                    let request =
                        engine::Change::from_wire(&wire, &operation, &removals, &packages)?;
                    let (p, c) = c.preview_change(&request, time)?;
                    (
                        "change",
                        p,
                        c,
                        Intent::Change {
                            operation,
                            packages,
                            removals,
                        },
                    )
                };
                let id = HEXLOWER.encode(&nonce()?);
                let result = json!({"id":id,"kind":kind,"fingerprint":HEXLOWER.encode(&preview.fingerprint),
                    "recipients":participants(&preview.recipients)});
                *self
                    .group_preview
                    .lock()
                    .map_err(|_| CryptoBridgeError::Closed)? = Some(Staged {
                    id,
                    room: wire.room_id,
                    consent,
                    intent,
                });
                result
            }
            Action::Confirm {
                roster: wire,
                id,
                fingerprint,
            } => {
                roster(&wire, &manager, &root)?;
                let staged = self
                    .group_preview
                    .lock()
                    .map_err(|_| CryptoBridgeError::Closed)?
                    .take()
                    .ok_or(CryptoBridgeError::Changed)?;
                if staged.id != id || staged.room != wire.room_id {
                    return Err(CryptoBridgeError::Changed);
                }
                let fp: [u8; 32] = HEXLOWER
                    .decode(fingerprint.as_bytes())
                    .map_err(|_| CryptoBridgeError::Integrity)?
                    .try_into()
                    .map_err(|_| CryptoBridgeError::Integrity)?;
                if HEXLOWER.encode(&fp) != fingerprint {
                    return Err(CryptoBridgeError::Integrity);
                }
                match staged.intent {
                    Intent::Genesis {
                        incarnation,
                        operation,
                        packages,
                    } => {
                        c.prepare_genesis(
                            &engine::Genesis::from_wire(&wire, incarnation, &operation, &packages)?,
                            &staged.consent,
                            fp,
                            time,
                        )?;
                    }
                    Intent::Change {
                        operation,
                        packages,
                        removals,
                    } => {
                        c.prepare_change(
                            &engine::Change::from_wire(&wire, &operation, &removals, &packages)?,
                            &staged.consent,
                            fp,
                            time,
                        )?;
                    }
                    Intent::Event { event, readmission } => {
                        if readmission {
                            c.accept_readmission(
                                &engine::Admission::from_wire(&wire, &event)?,
                                &staged.consent,
                                fp,
                                time,
                            )?;
                        } else if event.welcome.is_some() {
                            c.accept_admission(
                                &engine::Admission::from_wire(&wire, &event)?,
                                &staged.consent,
                                fp,
                                time,
                            )?;
                        } else {
                            c.accept_commit(
                                &engine::Commit::from_wire(&wire, &event)?,
                                &staged.consent,
                                fp,
                                time,
                            )?;
                        }
                    }
                }
                json!({"pending":pending(&c,&wire.room_id)?})
            }
            Action::Pending { room: id } => {
                room(&id)?;
                pending(&c, &id)?
            }
            Action::VoiceKey { room: id } => {
                room(&id)?;
                match c.voice_key(&id) {
                    Ok((epoch, key)) => {
                        json!({"epoch":epoch,"key":data_encoding::BASE64.encode(&key)})
                    }
                    Err(engine::Error::NotReady) => Value::Null,
                    Err(error) => return Err(error.into()),
                }
            }
            Action::Retry { room: id } => {
                room(&id)?;
                public(&c.retry(&id, time)?.to_wire()?)?
            }
            Action::Acknowledge { room: id, receipt } => {
                room(&id)?;
                if receipt.room_id != id {
                    return Err(CryptoBridgeError::Changed);
                }
                c.confirm(&engine::Receipt::from_wire(&receipt)?, time)?;
                Value::Null
            }
            Action::Cancel { room: id } => {
                room(&id)?;
                let original = c.pending_lookup(&id)?;
                match c.request_group_cancellation(&id, &original.operation, time)? {
                    engine::CancellationRequest::Original(original) => {
                        json!({"original":original.to_wire()?,"settlement":null})
                    }
                    engine::CancellationRequest::Known(known) => {
                        json!({"original":null,"settlement":settlement(&known)?})
                    }
                }
            }
            Action::Settle {
                room: id,
                settlement: wire,
            } => {
                room(&id)?;
                match engine::GroupSettlement::from_wire(&wire)? {
                    engine::GroupSettlement::Accepted(receipt) => {
                        if receipt.scope.room != id {
                            return Err(CryptoBridgeError::Changed);
                        }
                        c.confirm(&receipt, time)?;
                    }
                    engine::GroupSettlement::Cancelled(receipt) => {
                        if receipt.scope.room != id {
                            return Err(CryptoBridgeError::Changed);
                        }
                        c.confirm_group_cancellation(&receipt, time)?;
                    }
                }
                Value::Null
            }
            Action::Events {
                roster: wire,
                state,
                page,
            } => {
                roster(&wire, &manager, &root)?;
                let head = engine::Receipt::from_state(&state)?;
                let declared = engine::Receipt::from_wire(
                    wire.group.as_ref().ok_or(CryptoBridgeError::Changed)?,
                )?;
                if declared != head {
                    return Err(CryptoBridgeError::Changed);
                }
                let local = match c.accepted_receipt(&wire.room_id) {
                    Ok(value) => Some(value),
                    Err(engine::Error::NotReady) => None,
                    Err(error) => return Err(error.into()),
                };
                if local.as_ref().is_some_and(|v| {
                    v.scope != head.scope
                        || v.revision > head.revision
                        || v.revision == head.revision && v != &head
                }) {
                    return Err(CryptoBridgeError::Changed);
                }
                engine::wire::validate_page(
                    &page,
                    &head.scope,
                    local.as_ref().map_or(0, |v| v.revision),
                )?;
                // A commit after the journal started is applied by the journal
                // when the room is read: it is not a transition to review.
                // A Welcome (a readmission) still is, wherever it sits in the page.
                let journal = c.journal_started(&wire.room_id)?;
                public(&page.events.iter().find(|e| e.welcome.is_some() || !journal))?
            }
            Action::PackagesPrepare => {
                packages::Coordinator::new(manager, root)?.prepare(&revision, 4, time)?;
                Value::Null
            }
            Action::PackagesPending => {
                match packages::Coordinator::new(manager, root)?.pending_lookup() {
                    Ok(v) => json!({"operation":v.operation_id}),
                    Err(packages::Error::NotPending) => Value::Null,
                    Err(error) => return Err(error.into()),
                }
            }
            Action::PackagesRetry => {
                public(&packages::Coordinator::new(manager, root)?.retry(time)?)?
            }
            Action::PackagesAcknowledge { receipt } => {
                packages::Coordinator::new(manager, root)?.confirm(&receipt, time)?;
                Value::Null
            }
        };
        self.check()?;
        serde_json::to_string(&value).map_err(|_| CryptoBridgeError::Integrity)
    }
}
