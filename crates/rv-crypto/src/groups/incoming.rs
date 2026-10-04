use super::*;
use openmls::prelude::{ProcessedMessageContent, Sender};

/// A delivered successor for an already admitted device, plus independently
/// observed current grants. Targeted initial Welcomes use Admission instead.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Commit {
    pub roster: Roster,
    pub receipt: Receipt,
    #[serde(with = "bytes")]
    pub transition: Vec<u8>,
    #[serde(with = "bytes")]
    pub commit: Vec<u8>,
}

#[derive(Serialize)]
struct RoutingDevice<'a> {
    user: &'a str,
    device: &'a str,
    incarnation: [u8; 16],
    root: Fingerprint,
    certificate: Fingerprint,
    key_package: Option<Fingerprint>,
}
#[derive(Serialize)]
struct Routing<'a> {
    version: u8,
    scope: &'a Scope,
    operation: &'a str,
    expected_revision: u64,
    expected_epoch: Option<u64>,
    epoch: u64,
    previous: Fingerprint,
    authority_version: &'a str,
    members: &'a [Member],
    devices: Vec<RoutingDevice<'a>>,
}
/// Commit intent, without circular TLS digests or not-yet-assigned leaf indices.
/// The declared context/tree/actual indices are independently checked after MLS.
pub(super) fn commit_aad(plan: &Plan) -> Result<Vec<u8>> {
    plan.validate()?;
    let mut devices: Vec<_> = plan
        .participants
        .iter()
        .map(|p| RoutingDevice {
            user: &p.user,
            device: &p.device,
            incarnation: p.incarnation,
            root: p.root,
            certificate: p.certificate,
            key_package: p.key_package,
        })
        .collect();
    devices.sort_by(|a, b| a.device.cmp(b.device));
    let routing = Routing {
        version: 1,
        scope: &plan.scope,
        operation: &plan.operation,
        expected_revision: plan.expected_revision,
        expected_epoch: plan.expected_epoch,
        epoch: plan.epoch,
        previous: plan.previous,
        authority_version: &plan.authority_version,
        members: &plan.members,
        devices,
    };
    let payload = serde_json::to_vec(&routing).map_err(|_| Error::Changed)?;
    if payload.len() > public::WIRE_LIMIT {
        return Err(Error::Limit);
    };
    let mut aad = b"rocketvibe-mls-commit-routing-v1\0".to_vec();
    aad.extend(payload);
    Ok(aad)
}
pub(super) fn checked(commit: &Commit) -> Result<(Transition, Fingerprint)> {
    if commit.transition.len() > public::WIRE_LIMIT
        || commit.commit.is_empty()
        || commit.commit.len() > PAYLOAD_LIMIT
    {
        return Err(Error::Limit);
    };
    let transition = Transition::from_bytes(&commit.transition)?;
    let plan = &transition.plan;
    plan.validate()?;
    check_receipt(&transition, &commit.receipt)?;
    if plan.expected_revision == 0
        || plan.scope != commit.roster.scope
        || plan.authority_version != commit.roster.authority_version
        || plan.members != commit.roster.members
        || plan.commit != Some(digest(&commit.commit))
    {
        return Err(Error::Changed);
    };
    Ok((
        transition,
        fingerprint("rocketvibe-local-group-incoming-v1", commit)?,
    ))
}
fn same_admission(old: &Plan, new: &Plan, participant: &Participant) -> bool {
    old.members.iter().find(|m| m.user == participant.user)
        == new.members.iter().find(|m| m.user == participant.user)
        && old.participants.iter().any(|p| {
            p.user == participant.user
                && p.device == participant.device
                && p.incarnation == participant.incarnation
                && p.root == participant.root
                && p.leaf == participant.leaf
                && p.key_package == participant.key_package
        })
}
fn parent(active: &Active, transition: &Transition) -> Result<()> {
    let plan = &transition.plan;
    if plan.scope != active.receipt.scope
        || plan.expected_revision != active.receipt.revision
        || plan.expected_epoch != Some(active.receipt.epoch)
        || plan.previous != active.receipt.fingerprint
    {
        return Err(Error::Changed);
    };
    Ok(())
}
fn same_identity(a: &Certificate, b: &Certificate) -> bool {
    a.device.root == b.device.root
        && a.device.device == b.device.device
        && a.device.incarnation == b.device.incarnation
        && a.device.signature_key == b.device.signature_key
}
impl Coordinator {
    pub fn preview_commit(&self, commit: &Commit, now: u64) -> Result<(Preview, Consent)> {
        let (transition, intent) = checked(commit)?;
        self.scope(&transition.plan.scope)?;
        self.inspect(|provider, records| {
            let state = read(records, &transition.plan.scope.room)?.ok_or(Error::NotReady)?;
            check_clock(Some(&state), now)?;
            let context = self.context(records, now)?;
            let expires = self
                .validate_commit(provider, &context, &state, commit, &transition, now)?
                .min(context.certificate.device.expires_at)
                .min(transition.certificate.device.expires_at)
                .min(now.saturating_add(300));
            let state = fingerprint("rocketvibe-local-group-state-v1", &Some(&state))?;
            let own = context.certificate.fingerprint()?;
            let fingerprint = fingerprint(
                "rocketvibe-local-group-confirmation-v1",
                &(intent, state, context.pins_fingerprint, own, expires),
            )?;
            Ok((
                Preview {
                    fingerprint,
                    scope: transition.plan.scope.clone(),
                    recipients: transition.plan.participants,
                },
                Consent {
                    fingerprint,
                    intent,
                    state,
                    pins: context.pins_fingerprint,
                    own,
                    expires,
                },
            ))
        })
    }
    /// Processing, merge, successor receipt and superseded pending outbox are
    /// one protected transaction. A failed preview/accept never spends ratchets.
    pub fn accept_commit(
        &self,
        commit: &Commit,
        consent: &Consent,
        confirmed: Fingerprint,
        now: u64,
    ) -> Result<()> {
        let (transition, intent) = checked(commit)?;
        self.scope(&transition.plan.scope)?;
        if intent != consent.intent || confirmed != consent.fingerprint {
            return Err(Error::Changed);
        };
        self.transact(|provider, records| {
            if super::journal::started(records, &transition.plan.scope)? {
                return Err(Error::JournalOrder);
            }
            let mut state = read(records, &transition.plan.scope.room)?.ok_or(Error::NotReady)?;
            check_clock(Some(&state), now)?;
            if state.scope != transition.plan.scope {
                return Err(Error::Changed);
            };
            if let Some(active) = &state.active
                && active.receipt == commit.receipt
                && active.transition == transition
            {
                let group = MlsGroup::load(
                    provider.storage(),
                    &GroupId::from_slice(&state.scope.group_id()?),
                )
                .map_err(|_| Error::Mls)?
                .ok_or(Error::Changed)?;
                // Historical ACK reconciliation does not reauthorize encryption.
                return check_actual(group.public_group(), &active.transition.plan);
            }
            if now >= consent.expires
                || fingerprint("rocketvibe-local-group-state-v1", &Some(&state))? != consent.state
            {
                return Err(Error::Changed);
            };
            let context = self.context(records, now)?;
            if context.pins_fingerprint != consent.pins
                || context.certificate.fingerprint()? != consent.own
            {
                return Err(Error::Changed);
            };
            self.validate_commit(provider, &context, &state, commit, &transition, now)?;
            state.seen_packages.extend(
                transition
                    .plan
                    .participants
                    .iter()
                    .filter_map(|p| p.key_package),
            );
            state.clock = now;
            state.pending = None;
            state.active = Some(Active {
                created: now,
                historical: false,
                transition,
                receipt: commit.receipt.clone(),
            });
            save(records, &state)
        })
    }
    pub(super) fn validate_commit(
        &self,
        provider: &OpenMlsRustCrypto,
        context: &Context,
        state: &State,
        commit: &Commit,
        transition: &Transition,
        now: u64,
    ) -> Result<u64> {
        self.validate_commit_with(
            provider,
            context,
            state,
            commit,
            transition,
            Verification::Current(now),
        )
    }
    pub(super) fn validate_journal_commit(
        &self,
        provider: &OpenMlsRustCrypto,
        context: &Context,
        state: &State,
        commit: &Commit,
        transition: &Transition,
        now: u64,
    ) -> Result<u64> {
        self.validate_commit_with(
            provider,
            context,
            state,
            commit,
            transition,
            Verification::Historical(now),
        )
    }
    fn validate_commit_with(
        &self,
        provider: &OpenMlsRustCrypto,
        context: &Context,
        state: &State,
        commit: &Commit,
        transition: &Transition,
        verification: Verification,
    ) -> Result<u64> {
        let active = state.active.as_ref().ok_or(Error::NotReady)?;
        verification.transition(transition)?;
        parent(active, transition)?;
        let plan = &transition.plan;
        let references: BTreeSet<_> = plan
            .participants
            .iter()
            .filter_map(|p| p.key_package)
            .collect();
        if state.seen_packages.len() + references.difference(&state.seen_packages).count()
            > PACKAGE_HISTORY_LIMIT
        {
            return Err(Error::Limit);
        }
        let own = plan
            .participants
            .iter()
            .find(|p| p.device == context.certificate.device.device)
            .ok_or(Error::Changed)?;
        // A rejoin/new access grant must consume a fresh targeted Welcome; an
        // old group cannot turn its ratchets into the new admission implicitly.
        if !same_admission(&active.transition.plan, plan, own) {
            return Err(Error::Changed);
        };
        let mut group = MlsGroup::load(
            provider.storage(),
            &GroupId::from_slice(&state.scope.group_id()?),
        )
        .map_err(|_| Error::Mls)?
        .ok_or(Error::Changed)?;
        if group.ciphersuite() != SUITE {
            return Err(Error::Mls);
        };
        check_actual(group.public_group(), &active.transition.plan)?;
        if let Some(pending) = &state.pending {
            let prepared = Transition::from_bytes(&pending.submission.transition)?;
            parent(active, &prepared)?;
            let public = self.public_group(
                provider,
                &group,
                pending.group_info.as_deref(),
                &context.local,
            )?;
            check_actual(&public, &prepared.plan)?;
            if prepared == *transition {
                if pending.submission.commit.as_deref() != Some(commit.commit.as_slice()) {
                    return Err(Error::Changed);
                };
                for participant in &plan.participants {
                    if !same_admission(&active.transition.plan, plan, participant)
                        && (participant
                            .key_package
                            .is_none_or(|r| state.seen_packages.contains(&r))
                            || !plan.welcomes.iter().any(|w| {
                                w.device == participant.device
                                    && Some(w.key_package) == participant.key_package
                            }))
                    {
                        return Err(Error::Changed);
                    }
                }
                check_participants_with(&public, plan, context, verification)?;
                group
                    .merge_pending_commit(provider)
                    .map_err(|_| Error::Mls)?;
                check_actual(group.public_group(), plan)?;
                return check_participants_with(group.public_group(), plan, context, verification);
            }
            group
                .clear_pending_commit(provider.storage())
                .map_err(|_| Error::Mls)?;
        } else if group.pending_commit().is_some() {
            return Err(Error::Changed);
        };
        let message = MlsMessageIn::tls_deserialize_exact(&commit.commit)
            .map_err(|_| Error::Mls)?
            .try_into_protocol_message()
            .map_err(|_| Error::Mls)?;
        let processed = group
            .process_message(provider, message)
            .map_err(|_| Error::Mls)?;
        let Sender::Member(index) = processed.sender() else {
            return Err(Error::Changed);
        };
        let author = Certificate::from_credential(processed.credential())?;
        let old_member = group
            .members()
            .find(|m| m.index == *index)
            .ok_or(Error::Changed)?;
        let declared = &transition.certificate;
        // A legitimate renewed certificate can retain the MLS signing key.
        // Its old credential may be historical; the new proof is current and
        // still requires the explicitly approved root/incarnation/key.
        if Certificate::from_credential(&old_member.credential)? != author
            || !same_identity(&author, declared)
            || old_member.signature_key.as_slice() != declared.device.signature_key
            || !plan
                .participants
                .iter()
                .any(|p| p.device == declared.device.device && p.leaf == index.u32())
            || processed.aad() != commit_aad(plan)?
        {
            return Err(Error::Changed);
        };
        verification.peer(
            &context.pins,
            &declared.credential()?,
            &declared.device.signature_key,
        )?;
        let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content() else {
            return Err(Error::Mls);
        };
        if staged.self_removed() || staged.psk_proposals().next().is_some() {
            return Err(Error::Changed);
        };
        let mut additions = BTreeMap::new();
        let mut admitted = BTreeSet::new();
        for proposal in staged.add_proposals() {
            let package = proposal.add_proposal().key_package();
            if package.last_resort() || package.ciphersuite() != SUITE {
                return Err(Error::Changed);
            };
            let certificate = Certificate::from_credential(package.leaf_node().credential())?;
            let reference: Fingerprint = package
                .hash_ref(provider.crypto())
                .map_err(|_| Error::Mls)?
                .as_slice()
                .try_into()
                .map_err(|_| Error::Mls)?;
            if additions
                .insert(certificate.device.device.clone(), (certificate, reference))
                .is_some()
            {
                return Err(Error::Changed);
            };
        }
        for participant in &plan.participants {
            if same_admission(&active.transition.plan, plan, participant) {
                if additions.contains_key(&participant.device) {
                    return Err(Error::Changed);
                };
            } else {
                let (certificate, reference) = additions
                    .remove(&participant.device)
                    .ok_or(Error::Changed)?;
                if state.seen_packages.contains(&reference)
                    || participant.key_package != Some(reference)
                    || participant.certificate != certificate.fingerprint()?
                    || !plan.welcomes.iter().any(|w| {
                        w.device == participant.device
                            && w.incarnation == participant.incarnation
                            && w.key_package == reference
                    })
                {
                    return Err(Error::Changed);
                };
                admitted.insert(participant.device.as_str());
            }
        }
        if !additions.is_empty()
            || plan
                .welcomes
                .iter()
                .any(|w| !admitted.contains(w.device.as_str()))
        {
            return Err(Error::Changed);
        };
        group
            .merge_staged_commit(provider, *staged)
            .map_err(|_| Error::Mls)?;
        if group.ciphersuite() != SUITE {
            return Err(Error::Mls);
        };
        check_actual(group.public_group(), plan)?;
        check_participants_with(group.public_group(), plan, context, verification)
    }
}
