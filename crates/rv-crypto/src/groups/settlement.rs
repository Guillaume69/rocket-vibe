//! Terminal decisions for original group packets, independent of the live MLS
//! head. A peer successor may replace a pending commit, never its unresolved
//! public intention. This record shares the protected provider transaction.
use super::*;

const RECORD: &str = "crypto-group-settlements-v1";
const UNRESOLVED_LIMIT: usize = 16;
const TERMINAL_LIMIT: usize = 8192;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GroupCancellation {
    pub scope: Scope,
    pub operation: String,
    pub device: String,
    pub fingerprint: Fingerprint,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum GroupSettlement {
    Accepted(Receipt),
    Cancelled(GroupCancellation),
}
impl GroupSettlement {
    fn scope(&self) -> &Scope {
        match self {
            Self::Accepted(value) => &value.scope,
            Self::Cancelled(value) => &value.scope,
        }
    }
    fn operation(&self) -> &str {
        match self {
            Self::Accepted(value) => &value.operation,
            Self::Cancelled(value) => &value.operation,
        }
    }
}
pub(crate) enum CancellationRequest {
    Known(GroupSettlement),
    Original(Submission),
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    created: u64,
    submission: Submission,
    cancelling: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    version: u8,
    scope: vault::Scope,
    root: Fingerprint,
    clock: u64,
    unresolved: BTreeMap<String, Entry>,
    terminal: BTreeMap<String, GroupSettlement>,
}
impl Ledger {
    fn clock(&self, now: u64) -> Result<()> {
        if now < self.clock || now > 253_402_300_799 {
            return Err(Error::Changed);
        }
        Ok(())
    }
}
impl Coordinator {
    fn group_ledger(&self, records: &Records) -> Result<Ledger> {
        let Some(bytes) = records.get(RECORD) else {
            return Ok(Ledger {
                version: 1,
                scope: self.manager.scope().clone(),
                root: self.root.fingerprint()?,
                clock: 0,
                unresolved: BTreeMap::new(),
                terminal: BTreeMap::new(),
            });
        };
        if bytes.len() > STATE_LIMIT {
            return Err(Error::Limit);
        }
        let ledger: Ledger = serde_json::from_slice(bytes).map_err(|_| Error::Changed)?;
        if ledger.version != 1
            || ledger.scope != *self.manager.scope()
            || ledger.root != self.root.fingerprint()?
            || ledger.clock > 253_402_300_799
        {
            return Err(Error::Changed);
        }
        if ledger.unresolved.len() > UNRESOLVED_LIMIT || ledger.terminal.len() > TERMINAL_LIMIT {
            return Err(Error::Limit);
        }
        let mut rooms = BTreeSet::new();
        for (operation, entry) in &ledger.unresolved {
            self.group_original(&entry.submission, entry.created)?;
            if operation != &entry.submission.operation
                || ledger.terminal.contains_key(operation)
                || entry.created > ledger.clock
                || !rooms.insert(&entry.submission.scope.room)
            {
                return Err(Error::Changed);
            }
        }
        for (operation, decision) in &ledger.terminal {
            self.scope(decision.scope())?;
            if operation != decision.operation() || !wire::valid_identifier(operation) {
                return Err(Error::Changed);
            }
            match decision {
                GroupSettlement::Accepted(value) => {
                    value.to_wire()?;
                }
                GroupSettlement::Cancelled(value) => {
                    if value.device != self.manager.scope().device || value.fingerprint == [0; 32] {
                        return Err(Error::Changed);
                    }
                }
            }
        }
        Ok(ledger)
    }
    fn save_group_ledger(&self, records: &mut Records, ledger: &Ledger) -> Result<()> {
        if ledger.unresolved.len() > UNRESOLVED_LIMIT || ledger.terminal.len() > TERMINAL_LIMIT {
            return Err(Error::Limit);
        }
        let bytes = serde_json::to_vec(ledger).map_err(|_| Error::Changed)?;
        if bytes.len() > STATE_LIMIT {
            return Err(Error::Limit);
        }
        records.insert(RECORD.into(), bytes);
        Ok(())
    }
    fn group_original(&self, submission: &Submission, created: u64) -> Result<Transition> {
        check_payloads(submission)?;
        if submission.welcomes.len() >= public::MAX_DEVICES {
            return Err(Error::Limit);
        }
        let transition = Transition::from_bytes(&submission.transition)?;
        transition.verify(created)?;
        self.scope(&transition.plan.scope)?;
        let certificate = &transition.certificate;
        if certificate.device.root != self.root
            || certificate.device.device != self.manager.scope().device
            || HEXLOWER.encode(&certificate.device.incarnation) != self.manager.scope().incarnation
            || submission.scope != transition.plan.scope
            || submission.operation != transition.plan.operation
            || digest(&submission.tree) != transition.plan.tree
            || submission.commit.as_deref().map(digest) != transition.plan.commit
            || submission.welcomes.len() != transition.plan.welcomes.len()
            || submission
                .welcomes
                .iter()
                .zip(&transition.plan.welcomes)
                .any(|(a, b)| {
                    a.device != b.device
                        || a.incarnation != b.incarnation
                        || a.key_package != b.key_package
                        || digest(&a.payload) != b.digest
                })
        {
            return Err(Error::Changed);
        }
        Ok(transition)
    }
    fn remember_group(&self, ledger: &mut Ledger, pending: &Pending) -> Result<()> {
        let transition = self.group_original(&pending.submission, pending.created)?;
        let operation = &pending.submission.operation;
        if let Some(decision) = ledger.terminal.get(operation) {
            return match decision {
                GroupSettlement::Accepted(receipt) => check_receipt(&transition, receipt),
                GroupSettlement::Cancelled(_) => Err(Error::GroupCancelled),
            };
        }
        if let Some(entry) = ledger.unresolved.get(operation) {
            if fingerprint("rocketvibe-group-original-v1", &entry.submission)?
                != fingerprint("rocketvibe-group-original-v1", &pending.submission)?
            {
                return Err(Error::Conflict);
            }
            return Ok(());
        }
        if ledger
            .unresolved
            .values()
            .any(|e| e.submission.scope.room == pending.submission.scope.room)
        {
            return Err(Error::Pending);
        }
        ledger.unresolved.insert(
            operation.clone(),
            Entry {
                created: pending.created,
                submission: pending.submission.clone(),
                cancelling: false,
            },
        );
        Ok(())
    }
    pub(super) fn record_group_prepared(
        &self,
        records: &mut Records,
        pending: &Pending,
        now: u64,
    ) -> Result<()> {
        let mut ledger = self.group_ledger(records)?;
        ledger.clock(now)?;
        self.remember_group(&mut ledger, pending)?;
        ledger.clock = now;
        self.save_group_ledger(records, &ledger)
    }
    pub(super) fn check_group_preparation(
        &self,
        records: &Records,
        room: &str,
        operation: &str,
        now: u64,
    ) -> Result<()> {
        let ledger = self.group_ledger(records)?;
        ledger.clock(now)?;
        if let Some(decision) = ledger.terminal.get(operation) {
            return Err(match decision {
                GroupSettlement::Cancelled(_) => Error::GroupCancelled,
                GroupSettlement::Accepted(_) => Error::Conflict,
            });
        }
        if let Some(entry) = ledger
            .unresolved
            .values()
            .find(|e| e.submission.scope.room == room)
        {
            let state = read(records, room)?;
            if state
                .as_ref()
                .and_then(|s| s.pending.as_ref())
                .is_none_or(|p| p.submission.operation != entry.submission.operation)
            {
                return Err(Error::Pending);
            }
        }
        Ok(())
    }
    pub(super) fn group_retry_allowed(&self, records: &Records, operation: &str) -> Result<()> {
        let ledger = self.group_ledger(records)?;
        if matches!(
            ledger.terminal.get(operation),
            Some(GroupSettlement::Cancelled(_))
        ) {
            return Err(Error::GroupCancelled);
        }
        if ledger
            .unresolved
            .get(operation)
            .is_some_and(|e| e.cancelling)
        {
            return Err(Error::GroupCancelling);
        }
        Ok(())
    }
    /// A known terminal result is local and does not depend on current trust or
    /// membership. Unknown originals remain protected and cannot be discarded.
    pub fn group_settlement(&self, operation: &str) -> Result<Option<GroupSettlement>> {
        if !wire::valid_identifier(operation) {
            return Err(Error::Changed);
        }
        self.inspect(|_, records| Ok(self.group_ledger(records)?.terminal.get(operation).cloned()))
    }
    pub(super) fn group_settlement_in(
        &self,
        records: &Records,
        operation: &str,
        now: u64,
    ) -> Result<Option<GroupSettlement>> {
        let ledger = self.group_ledger(records)?;
        ledger.clock(now)?;
        Ok(ledger.terminal.get(operation).cloned())
    }
    pub(super) fn group_pending_lookup(
        &self,
        records: &Records,
        room: &str,
    ) -> Result<PendingLookup> {
        key(room)?;
        let ledger = self.group_ledger(records)?;
        let state = read(records, room)?;
        let pending = state.as_ref().and_then(|s| s.pending.as_ref());
        let submission = pending
            .map(|p| &p.submission)
            .or_else(|| {
                ledger
                    .unresolved
                    .values()
                    .find(|e| e.submission.scope.room == room)
                    .map(|e| &e.submission)
            })
            .ok_or(Error::NotReady)?;
        let transition = Transition::from_bytes(&submission.transition)?;
        self.scope(&submission.scope)?;
        Ok(PendingLookup {
            scope: submission.scope.clone(),
            operation: submission.operation.clone(),
            fingerprint: transition.fingerprint()?,
            cancelling: ledger
                .unresolved
                .get(&submission.operation)
                .is_some_and(|e| e.cancelling),
            superseded: pending.is_none(),
        })
    }
    pub(crate) fn request_group_cancellation(
        &self,
        room: &str,
        operation: &str,
        now: u64,
    ) -> Result<CancellationRequest> {
        key(room)?;
        if !wire::valid_identifier(operation) {
            return Err(Error::Changed);
        }
        self.transact(|_, records| {
            let mut ledger = self.group_ledger(records)?;
            ledger.clock(now)?;
            if let Some(decision) = ledger.terminal.get(operation) {
                if decision.scope().room != room {
                    return Err(Error::Receipt);
                }
                return Ok(CancellationRequest::Known(decision.clone()));
            }
            let state = read(records, room)?;
            check_clock(state.as_ref(), now)?;
            if let Some(pending) = state.as_ref().and_then(|s| s.pending.as_ref()) {
                self.remember_group(&mut ledger, pending)?;
            }
            let entry = ledger
                .unresolved
                .get_mut(operation)
                .ok_or(Error::NotReady)?;
            if entry.submission.scope.room != room {
                return Err(Error::Receipt);
            }
            entry.cancelling = true;
            let original = entry.submission.clone();
            ledger.clock = now;
            self.save_group_ledger(records, &ledger)?;
            Ok(CancellationRequest::Original(original))
        })
    }
    pub fn confirm_group_cancellation(
        &self,
        cancellation: &GroupCancellation,
        now: u64,
    ) -> Result<()> {
        self.scope(&cancellation.scope)?;
        self.transact(|provider, records| {
            let mut ledger = self.group_ledger(records)?;
            ledger.clock(now)?;
            let decision = GroupSettlement::Cancelled(cancellation.clone());
            if let Some(saved) = ledger.terminal.get(&cancellation.operation) {
                return if saved == &decision {
                    Ok(())
                } else {
                    Err(Error::Receipt)
                };
            }
            let entry = ledger
                .unresolved
                .get(&cancellation.operation)
                .ok_or(Error::NotReady)?;
            let transition = self.group_original(&entry.submission, entry.created)?;
            if !entry.cancelling
                || cancellation.scope != transition.plan.scope
                || cancellation.device != transition.certificate.device.device
                || cancellation.operation != transition.plan.operation
                || cancellation.fingerprint != transition.fingerprint()?
            {
                return Err(Error::Receipt);
            }
            if let Some(mut state) = read(records, &cancellation.scope.room)? {
                check_clock(Some(&state), now)?;
                if state.pending.as_ref().is_some_and(|p| {
                    p.submission.operation == cancellation.operation
                        && p.submission.scope == cancellation.scope
                }) {
                    let mut group = MlsGroup::load(
                        provider.storage(),
                        &GroupId::from_slice(&state.scope.group_id()?),
                    )
                    .map_err(|_| Error::Mls)?
                    .ok_or(Error::Changed)?;
                    if let Some(active) = &state.active {
                        group
                            .clear_pending_commit(provider.storage())
                            .map_err(|_| Error::Mls)?;
                        check_actual(group.public_group(), &active.transition.plan)?;
                        state.pending = None;
                        state.clock = now;
                        save(records, &state)?;
                    } else {
                        group.delete(provider.storage()).map_err(|_| Error::Mls)?;
                        records.remove(&key(&state.scope.room)?);
                    }
                } else if state.scope == cancellation.scope {
                    state.clock = now;
                    save(records, &state)?;
                }
            }
            ledger.unresolved.remove(&cancellation.operation);
            ledger
                .terminal
                .insert(cancellation.operation.clone(), decision);
            ledger.clock = now;
            self.save_group_ledger(records, &ledger)
        })
    }
    pub(super) fn record_group_ack(
        &self,
        records: &mut Records,
        pending: &Pending,
        receipt: &Receipt,
        now: u64,
    ) -> Result<()> {
        let mut ledger = self.group_ledger(records)?;
        ledger.clock(now)?;
        self.remember_group(&mut ledger, pending)?;
        check_receipt(
            &self.group_original(&pending.submission, pending.created)?,
            receipt,
        )?;
        let decision = GroupSettlement::Accepted(receipt.clone());
        if ledger
            .terminal
            .get(&receipt.operation)
            .is_some_and(|saved| saved != &decision)
        {
            return Err(Error::Receipt);
        }
        ledger.unresolved.remove(&receipt.operation);
        ledger.terminal.insert(receipt.operation.clone(), decision);
        ledger.clock = now;
        self.save_group_ledger(records, &ledger)
    }
    pub(super) fn record_group_delivery(
        &self,
        records: &mut Records,
        state: &State,
        receipt: &Receipt,
        now: u64,
    ) -> Result<()> {
        if let Some(pending) = &state.pending {
            if pending.submission.operation == receipt.operation {
                self.record_group_ack(records, pending, receipt, now)?;
            } else {
                if matches!(
                    self.group_ledger(records)?
                        .terminal
                        .get(&pending.submission.operation),
                    Some(GroupSettlement::Accepted(_))
                ) {
                    return Err(Error::Receipt);
                }
                self.record_group_prepared(records, pending, now)?;
            }
        }
        Ok(())
    }
}
