//! Complete page checkpoints in the same protected transaction as MLS and
//! private cleartext. Sending keeps its separate fresh-current-state policy.
use super::*;
use rv_protocol::e2ee as http;

pub struct JournalObservation {
    pub current: MessageObservation,
    pub transition: Vec<u8>,
}
impl JournalObservation {
    pub fn from_wire(roster: &http::GroupRoster, state: &http::GroupState) -> Result<Self> {
        Ok(Self {
            current: MessageObservation::from_wire(roster, state)?,
            transition: wire::state_transition(state)?,
        })
    }
}
/// Resume only from protected metadata, never an app-supplied page cursor.
pub struct JournalRequest {
    pub scope: Scope,
    pub after: u64,
    pub through: Option<u64>,
}
/// No cleartext escapes until the entire page and its prefix are protected.
/// A finished window covers `through`, even when the native sequence has gaps.
pub struct JournalBatch {
    pub head: Receipt,
    pub after: u64,
    pub through: u64,
    pub complete: bool,
    pub messages: Vec<ClearMessage>,
}
/// A bounded view of the protected, verified journal prefix. `before` stays a
/// u64 at the private boundary; frontends encode positions as decimal strings.
pub struct ProjectionQuery {
    pub before: Option<u64>,
    pub limit: usize,
    pub thread: Option<String>,
}
pub struct ProjectedMessage {
    pub message: ClearMessage,
    /// Local protected observation/preparation time, not a signed send time.
    pub observed_at: u64,
}
pub struct JournalProjection {
    pub head: Receipt,
    pub admission: Fingerprint,
    pub after: u64,
    pub complete: bool,
    pub has_older: bool,
    pub messages: Vec<ProjectedMessage>,
    /// Root of the requested thread, only when retained in this same verified
    /// prefix and personal grant. Never recovered from the ordinary app cache.
    pub root: Option<ProjectedMessage>,
    /// Counts of retained replies, not remote/full-archive thread counts.
    pub retained_replies: BTreeMap<String, u32>,
}
/// Reader-bound source lookup for private references, including thread replies.
/// Absence never falls back to an ordinary SQL/message cache.
pub struct JournalSources {
    pub admission: Fingerprint,
    pub after: u64,
    pub messages: Vec<ProjectedMessage>,
}
pub(super) struct RetainedProjection {
    pub messages: Vec<ProjectedMessage>,
    pub has_older: bool,
    pub root: Option<ProjectedMessage>,
    pub replies: BTreeMap<String, u32>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    scope: Scope,
    admission: Fingerprint,
    clock: u64,
    after: u64,
    through: Option<u64>,
    head: Receipt,
    batch_through: u64,
    positions: Vec<u64>,
}
fn key(room: &str) -> Result<String> {
    super::key(room)?;
    Ok(format!("crypto-journal-v1/{room}"))
}
fn read(records: &Records, scope: &Scope) -> Result<Option<Cursor>> {
    let Some(bytes) = records.get(&key(&scope.room)?) else {
        return Ok(None);
    };
    if bytes.len() > 4096 {
        return Err(Error::Limit);
    }
    let cursor: Cursor = serde_json::from_slice(bytes).map_err(|_| Error::Changed)?;
    cursor.head.to_wire()?;
    if cursor.version != 1
        || cursor.scope != *scope
        || cursor.head.scope != *scope
        || cursor.admission == [0; 32]
        || cursor.clock > 253_402_300_799
        || cursor.after > i64::MAX as u64
        || cursor.batch_through < cursor.after
        || cursor.batch_through > i64::MAX as u64
        || cursor.positions.len() > 16
        || cursor
            .positions
            .iter()
            .any(|p| *p == 0 || *p > cursor.after)
        || cursor.positions.windows(2).any(|p| p[0] >= p[1])
        || cursor
            .through
            .is_some_and(|end| end <= cursor.after || end > i64::MAX as u64)
    {
        return Err(Error::JournalOrder);
    }
    Ok(Some(cursor))
}
pub(super) fn started(records: &Records, scope: &Scope) -> Result<bool> {
    Ok(read(records, scope)?.is_some())
}
pub(super) fn reset_admission(records: &mut Records, scope: &Scope) -> Result<()> {
    read(records, scope)?;
    records.remove(&key(&scope.room)?);
    Ok(())
}
impl Coordinator {
    pub(super) fn admission_witness(&self, plan: &Plan, grant: &Member) -> Result<Fingerprint> {
        let scope = self.manager.scope();
        let own = plan
            .participants
            .iter()
            .find(|p| p.device == scope.device)
            .ok_or(Error::JournalOrder)?;
        if own.user != scope.user
            || HEXLOWER.encode(&own.incarnation) != scope.incarnation
            || own.root != self.root.fingerprint()?
            || plan.members.iter().find(|m| m.user == scope.user) != Some(grant)
        {
            return Err(Error::JournalOrder);
        }
        // Certificate renewal keeps the admission. Leaf/package/root/key
        // incarnation and personal grant changes require a fresh admission.
        fingerprint(
            "rocketvibe-journal-admission-v1",
            &(
                &plan.scope,
                grant,
                &own.user,
                &own.device,
                own.incarnation,
                own.root,
                own.leaf,
                own.key_package,
            ),
        )
    }
    fn journal_request_inner(&self, records: &Records, room: &str) -> Result<JournalRequest> {
        let state = super::read(records, room)?.ok_or(Error::NotReady)?;
        self.scope(&state.scope)?;
        let head = &state.active.as_ref().ok_or(Error::NotReady)?.receipt;
        let cursor = read(records, &state.scope)?;
        if cursor.as_ref().is_some_and(|cursor| cursor.head != *head) {
            return Err(Error::JournalOrder);
        }
        Ok(JournalRequest {
            scope: state.scope,
            after: cursor.as_ref().map_or(0, |cursor| cursor.after),
            through: cursor.and_then(|cursor| cursor.through),
        })
    }
    pub fn journal_request(&self, room: &str) -> Result<JournalRequest> {
        self.inspect(|_, records| self.journal_request_inner(records, room))
    }
    /// Authenticate all messages/commits and save the complete prefix atomically.
    /// The initial Welcome/genesis must already have been explicitly accepted.
    /// Historical recipients come from signed plans and actual MLS; only the
    /// reader's admission must match the independently observed current grant.
    pub fn receive_journal(
        &self,
        observation: &JournalObservation,
        page: &http::DeliveryPage,
        now: u64,
    ) -> Result<JournalBatch> {
        let current = &observation.current;
        check_request(&current.roster, "journal-control", &[])?;
        self.scope(&current.head.scope)?;
        let remote = Transition::from_bytes(&observation.transition)?;
        Verification::Historical(now).transition(&remote)?;
        check_receipt(&remote, &current.head)?;
        if current.roster.scope != current.head.scope {
            return Err(Error::JournalOrder);
        }
        let grant = current
            .roster
            .members
            .iter()
            .find(|m| m.user == self.manager.scope().user)
            .ok_or(Error::JournalOrder)?;
        let admission = self.admission_witness(&remote.plan, grant)?;
        self.transact(|provider, records| {
            let request = self.journal_request_inner(records, &page.room_id)?;
            if request.scope != current.head.scope {
                return Err(Error::JournalOrder);
            }
            let decoded = wire::delivery(page, &request.scope, request.after, request.through)?;
            let previous = read(records, &request.scope)?;
            let mut state = super::read(records, &request.scope.room)?.ok_or(Error::NotReady)?;
            check_clock(Some(&state), now)?;
            if previous
                .as_ref()
                .is_some_and(|c| c.admission != admission || c.clock > now)
            {
                return Err(Error::JournalOrder);
            }
            let active = state.active.as_ref().ok_or(Error::NotReady)?;
            if active.receipt.revision > current.head.revision
                || active.receipt.revision == current.head.revision
                    && active.receipt != current.head
                || self.admission_witness(&active.transition.plan, grant)? != admission
            {
                return Err(Error::JournalOrder);
            }
            let context = self.context(records, now)?;
            let mut bootstrap = previous.is_none();
            let mut messages = Vec::new();
            for (_, content) in decoded.events {
                match content {
                    wire::DeliveryContent::Group(event) => {
                        let transition = Transition::from_bytes(&event.transition)?;
                        if self.admission_witness(&transition.plan, grant)? != admission
                            || event.receipt.revision > current.head.revision
                            || event.receipt.revision == current.head.revision
                                && event.receipt != current.head
                        {
                            return Err(Error::JournalOrder);
                        }
                        let active = state.active.as_ref().ok_or(Error::NotReady)?;
                        if bootstrap {
                            if event.receipt != active.receipt || transition != active.transition {
                                return Err(Error::JournalOrder);
                            }
                            if let Some(welcome) = &event.welcome
                                && (welcome.device != self.manager.scope().device
                                    || HEXLOWER.encode(&welcome.incarnation)
                                        != self.manager.scope().incarnation)
                            {
                                return Err(Error::JournalOrder);
                            }
                            let group = MlsGroup::load(
                                provider.storage(),
                                &GroupId::from_slice(&state.scope.group_id()?),
                            )
                            .map_err(|_| Error::Mls)?
                            .ok_or(Error::Changed)?;
                            check_actual(group.public_group(), &transition.plan)?;
                            check_participants_with(
                                group.public_group(),
                                &transition.plan,
                                &context,
                                Verification::Historical(now),
                            )?;
                            bootstrap = false;
                        } else {
                            if event.welcome.is_some() {
                                return Err(Error::JournalOrder);
                            }
                            let commit = Commit {
                                roster: Roster {
                                    scope: state.scope.clone(),
                                    authority_version: transition.plan.authority_version.clone(),
                                    members: transition.plan.members.clone(),
                                },
                                receipt: event.receipt,
                                transition: event.transition,
                                commit: event.commit.ok_or(Error::Changed)?,
                            };
                            incoming::checked(&commit)?;
                            self.validate_journal_commit(
                                provider,
                                &context,
                                &state,
                                &commit,
                                &transition,
                                now,
                            )?;
                            state.seen_packages.extend(
                                transition
                                    .plan
                                    .participants
                                    .iter()
                                    .filter_map(|p| p.key_package),
                            );
                            self.record_group_delivery(records, &state, &commit.receipt, now)?;
                            state.pending = None;
                            state.clock = now;
                            state.active = Some(Active {
                                created: now,
                                historical: true,
                                transition,
                                receipt: commit.receipt,
                            });
                            save(records, &state)?;
                        }
                    }
                    wire::DeliveryContent::Message(submission, receipt) => {
                        if bootstrap {
                            return Err(Error::JournalOrder);
                        }
                        let active = state.active.as_ref().ok_or(Error::NotReady)?;
                        let historical = MessageObservation {
                            roster: Roster {
                                scope: state.scope.clone(),
                                authority_version: active.transition.plan.authority_version.clone(),
                                members: active.transition.plan.members.clone(),
                            },
                            head: active.receipt.clone(),
                            needs_rekey: false,
                        };
                        // Even cached echoes must occupy their original epoch
                        // here; the one-frame replay API has a different policy.
                        if receipt.header.group_revision != active.receipt.revision
                            || receipt.header.epoch != active.receipt.epoch
                            || receipt.header.group_fingerprint != active.receipt.fingerprint
                        {
                            return Err(Error::JournalOrder);
                        }
                        messages.push(self.receive_message_inner(
                            provider,
                            records,
                            &historical,
                            &submission,
                            &receipt,
                            now,
                            true,
                        )?);
                        state =
                            super::read(records, &request.scope.room)?.ok_or(Error::NotReady)?;
                    }
                }
            }
            if bootstrap {
                return Err(Error::JournalOrder);
            }
            state.clock = now;
            save(records, &state)?;
            let head = state
                .active
                .as_ref()
                .ok_or(Error::NotReady)?
                .receipt
                .clone();
            let cursor = Cursor {
                version: 1,
                scope: request.scope,
                admission,
                clock: now,
                after: decoded.next.unwrap_or(decoded.through),
                through: decoded.next.map(|_| decoded.through),
                head: head.clone(),
                batch_through: decoded.through,
                positions: messages.iter().map(|m| m.receipt.position).collect(),
            };
            let bytes = serde_json::to_vec(&cursor).map_err(|_| Error::Changed)?;
            if bytes.len() > 4096 {
                return Err(Error::Limit);
            }
            records.insert(key(&cursor.scope.room)?, bytes);
            Ok(JournalBatch {
                head,
                after: cursor.after,
                through: decoded.through,
                complete: decoded.next.is_none(),
                messages,
            })
        })
    }
    /// Replay the last protected page after a lost checkpoint/UI result. No new
    /// ratchets are consumed. The app must project it before requesting another
    /// page; cleartext remains only in the protected store.
    pub fn journal_last_batch(
        &self,
        observation: &JournalObservation,
        now: u64,
    ) -> Result<JournalBatch> {
        self.journal_inspect(observation, now, |records, cursor, grant| {
            let messages = self.journal_clear(records, &cursor.scope, grant, &cursor.positions)?;
            Ok(JournalBatch {
                head: cursor.head.clone(),
                after: cursor.after,
                through: cursor.batch_through,
                complete: cursor.through.is_none(),
                messages,
            })
        })
    }
    pub fn journal_projection(
        &self,
        observation: &JournalObservation,
        query: &ProjectionQuery,
        now: u64,
    ) -> Result<JournalProjection> {
        if query.limit == 0
            || query.limit > 200
            || query.before.is_some_and(|p| p == 0 || p > i64::MAX as u64)
            || query
                .thread
                .as_ref()
                .is_some_and(|id| !wire::valid_identifier(id))
        {
            return Err(Error::Limit);
        }
        self.journal_inspect(observation, now, |records, cursor, grant| {
            let retained =
                self.project_journal(records, &cursor.scope, grant, cursor.after, query)?;
            Ok(JournalProjection {
                head: cursor.head.clone(),
                admission: cursor.admission,
                after: cursor.after,
                complete: cursor.through.is_none(),
                has_older: retained.has_older,
                messages: retained.messages,
                root: retained.root,
                retained_replies: retained.replies,
            })
        })
    }
    pub fn journal_sources(
        &self,
        observation: &JournalObservation,
        now: u64,
    ) -> Result<JournalSources> {
        self.journal_inspect(observation, now, |records, cursor, grant| {
            Ok(JournalSources {
                admission: cursor.admission,
                after: cursor.after,
                messages: self.project_sources(records, &cursor.scope, grant, cursor.after)?,
            })
        })
    }
    fn journal_inspect<T>(
        &self,
        observation: &JournalObservation,
        now: u64,
        project: impl FnOnce(&Records, &Cursor, &Member) -> Result<T>,
    ) -> Result<T> {
        let current = &observation.current;
        check_request(&current.roster, "journal-control", &[])?;
        let remote = Transition::from_bytes(&observation.transition)?;
        Verification::Historical(now).transition(&remote)?;
        check_receipt(&remote, &current.head)?;
        if current.roster.scope != current.head.scope {
            return Err(Error::JournalOrder);
        }
        let grant = current
            .roster
            .members
            .iter()
            .find(|m| m.user == self.manager.scope().user)
            .ok_or(Error::JournalOrder)?;
        let admission = self.admission_witness(&remote.plan, grant)?;
        self.inspect(|_, records| {
            self.context(records, now)?;
            let request = self.journal_request_inner(records, &current.head.scope.room)?;
            let state = super::read(records, &request.scope.room)?.ok_or(Error::NotReady)?;
            check_clock(Some(&state), now)?;
            let cursor = read(records, &request.scope)?.ok_or(Error::NotReady)?;
            if cursor.admission != admission
                || cursor.clock > now
                || cursor.head.revision > current.head.revision
                || cursor.head.revision == current.head.revision && cursor.head != current.head
            {
                return Err(Error::JournalOrder);
            }
            project(records, &cursor, grant)
        })
    }
}
