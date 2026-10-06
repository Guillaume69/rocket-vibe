use super::*;
use openmls::prelude::{LeafNodeIndex, LeafNodeParameters};

/// Current independent server observations, explicit removals and fresh public
/// KeyPackages. Empty removals/packages rotate the author leaf. No private MLS
/// state or signer is supplied by the app or by an HTTP response.
#[derive(Clone)]
pub struct Change {
    pub roster: Roster,
    pub head: Receipt,
    pub operation: String,
    pub removals: Vec<String>,
    pub packages: Vec<Vec<u8>>,
}

fn intent(request: &Change) -> Result<Fingerprint> {
    // Bound public input before copying, sorting or hashing it.
    check_request(&request.roster, &request.operation, &request.packages)?;
    if request.head.operation.len() > 128
        || request.removals.len() >= public::MAX_DEVICES
        || request.removals.iter().any(|d| d.len() > 128)
    {
        return Err(Error::Limit);
    }
    if request.head.scope != request.roster.scope {
        return Err(Error::Changed);
    }
    let removals: BTreeSet<_> = request.removals.iter().collect();
    if removals.len() != request.removals.len()
        || removals.iter().any(|d| !rv_crypto_public::label(d))
    {
        return Err(Error::Changed);
    }
    let mut packages: Vec<_> = request.packages.iter().map(|p| digest(p)).collect();
    packages.sort();
    fingerprint(
        "rocketvibe-local-group-change-v1",
        &(
            &request.roster,
            &request.head,
            &request.operation,
            removals,
            packages,
        ),
    )
}

impl Coordinator {
    /// Inspect the actual old MLS tree before approving its next participants.
    /// Removed peers may already be revoked/expired; retained peers may not.
    fn change_plan(
        &self,
        provider: &OpenMlsRustCrypto,
        context: &Context,
        state: &State,
        request: &Change,
        now: u64,
    ) -> Result<(Plan, Vec<LeafNodeIndex>, Vec<Peer>, u64)> {
        let active = state.active.as_ref().ok_or(Error::NotReady)?;
        if active.receipt != request.head || state.scope != request.roster.scope {
            return Err(Error::Changed);
        }
        let group = MlsGroup::load(
            provider.storage(),
            &GroupId::from_slice(&state.scope.group_id()?),
        )
        .map_err(|_| Error::Mls)?
        .ok_or(Error::Changed)?;
        if group.ciphersuite() != SUITE
            || group.pending_commit().is_some()
            || group.pending_proposals().next().is_some()
        {
            return Err(Error::Changed);
        }
        check_actual(group.public_group(), &active.transition.plan)?;
        let old = &active.transition.plan;
        let mut plan = old.clone();
        plan.operation = request.operation.clone();
        plan.expected_revision = request.head.revision;
        plan.expected_epoch = Some(request.head.epoch);
        plan.epoch = request.head.epoch.checked_add(1).ok_or(Error::Limit)?;
        plan.previous = request.head.fingerprint;
        plan.authority_version = request.roster.authority_version.clone();
        plan.members = request.roster.members.clone();
        plan.participants.clear();
        plan.welcomes.clear();
        plan.context = [1; 32];
        plan.tree = [1; 32];
        plan.commit = Some([1; 32]);
        let removals: BTreeSet<_> = request.removals.iter().map(String::as_str).collect();
        let mut removed = Vec::new();
        let mut expires = context.certificate.device.expires_at;
        let mut own = false;
        let mut count = 0;
        for member in group.members() {
            count += 1;
            let certificate = Certificate::from_credential(&member.credential)?;
            let device = &certificate.device;
            let participant = old
                .participants
                .iter()
                .find(|p| p.leaf == member.index.u32())
                .ok_or(Error::Changed)?;
            if participant.user != device.root.user
                || participant.device != device.device
                || participant.incarnation != device.incarnation
                || participant.root != device.root.fingerprint()?
                || participant.certificate != certificate.fingerprint()?
                || member.signature_key.as_slice() != device.signature_key
            {
                return Err(Error::Changed);
            }
            if removals.contains(device.device.as_str()) {
                if device.device == context.certificate.device.device {
                    return Err(Error::Changed);
                }
                removed.push(member.index);
                continue;
            }
            // A changed access/activation nonce requires an actual Remove+Add.
            if old.members.iter().find(|m| m.user == participant.user)
                != plan.members.iter().find(|m| m.user == participant.user)
            {
                return Err(Error::Changed);
            }
            let mut participant = participant.clone();
            if device.device == context.certificate.device.device {
                let current = &context.certificate.device;
                if device.root != current.root
                    || device.incarnation != current.incarnation
                    || device.signature_key != current.signature_key
                    || member.index != group.own_leaf_index()
                {
                    return Err(Error::Changed);
                }
                participant.certificate = context.certificate.fingerprint()?;
                own = true;
            } else {
                context.pins.authorize_credential(
                    &member.credential,
                    &member.signature_key,
                    now,
                )?;
                expires = expires.min(device.expires_at);
            }
            plan.participants.push(participant);
        }
        if !own || count != old.participants.len() || removed.len() != removals.len() {
            return Err(Error::Changed);
        }
        let peers = self.peers(provider, context, &request.packages, now)?;
        let mut devices: BTreeSet<_> = plan.participants.iter().map(|p| p.device.clone()).collect();
        let mut references = BTreeSet::new();
        let mut occupied: BTreeSet<_> = plan.participants.iter().map(|p| p.leaf).collect();
        for peer in &peers {
            let device = &peer.certificate.device;
            if !devices.insert(device.device.clone())
                || state.seen_packages.contains(&peer.reference)
                || !references.insert(peer.reference)
            {
                return Err(Error::Changed);
            }
            // Preview indices are placeholders only. Derive the real indices
            // from the validated staged public tree before signing the proof.
            let leaf = (0..=4095)
                .find(|l| !occupied.contains(l))
                .ok_or(Error::Limit)?;
            occupied.insert(leaf);
            plan.participants.push(Participant {
                user: device.root.user.clone(),
                device: device.device.clone(),
                incarnation: device.incarnation,
                root: device.root.fingerprint()?,
                certificate: peer.certificate.fingerprint()?,
                leaf,
                key_package: Some(peer.reference),
            });
            plan.welcomes.push(public::Welcome {
                device: device.device.clone(),
                incarnation: device.incarnation,
                key_package: peer.reference,
                digest: [1; 32],
            });
            expires = expires.min(device.expires_at);
        }
        if state.seen_packages.len() + references.len() > PACKAGE_HISTORY_LIMIT {
            return Err(Error::Limit);
        }
        plan.participants.sort_by_key(|p| p.leaf);
        plan.welcomes.sort_by(|a, b| a.device.cmp(&b.device));
        plan.validate()?;
        Ok((plan, removed, peers, expires.min(now.saturating_add(300))))
    }

    pub fn preview_change(&self, request: &Change, now: u64) -> Result<(Preview, Consent)> {
        let intent = intent(request)?;
        self.scope(&request.roster.scope)?;
        self.inspect(|provider, records| {
            self.check_group_preparation(
                records,
                &request.roster.scope.room,
                &request.operation,
                now,
            )?;
            let state = read(records, &request.roster.scope.room)?.ok_or(Error::NotReady)?;
            check_clock(Some(&state), now)?;
            if state.pending.is_some() || self.pending_messages(records, &state.scope)? {
                return Err(Error::Pending);
            }
            let context = self.context(records, now)?;
            let (plan, _, _, expires) =
                self.change_plan(provider, &context, &state, request, now)?;
            let state = consent_state(Some(&state))?;
            let own = context.certificate.fingerprint()?;
            let fingerprint = fingerprint(
                "rocketvibe-local-group-confirmation-v1",
                &(intent, state, context.pins_fingerprint, own, expires),
            )?;
            Ok((
                Preview {
                    fingerprint,
                    scope: plan.scope,
                    recipients: plan.participants,
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

    /// Prepare one real MLS successor and its exact signed HTTP payload in the
    /// protected transaction. The old accepted epoch stays active until ACK.
    pub fn prepare_change(
        &self,
        request: &Change,
        consent: &Consent,
        confirmed: Fingerprint,
        now: u64,
    ) -> Result<Submission> {
        let intent = intent(request)?;
        self.scope(&request.roster.scope)?;
        if intent != consent.intent || confirmed != consent.fingerprint {
            return Err(Error::Changed);
        }
        self.transact(|provider, records| {
            self.check_group_preparation(
                records,
                &request.roster.scope.room,
                &request.operation,
                now,
            )?;
            let mut state = read(records, &request.roster.scope.room)?.ok_or(Error::NotReady)?;
            check_clock(Some(&state), now)?;
            if self.pending_messages(records, &state.scope)? {
                return Err(Error::Pending);
            }
            if let Some(pending) = &state.pending {
                if pending.intent != intent || pending.submission.operation != request.operation {
                    return Err(Error::Conflict);
                }
                return self.retry_pending(provider, records, pending, now);
            }
            if now >= consent.expires || consent_state(Some(&state))? != consent.state {
                return Err(Error::Changed);
            }
            let context = self.context(records, now)?;
            if context.pins_fingerprint != consent.pins
                || context.certificate.fingerprint()? != consent.own
            {
                return Err(Error::Changed);
            }
            let (mut plan, removed, peers, _) =
                self.change_plan(provider, &context, &state, request, now)?;
            let mut group = MlsGroup::load(
                provider.storage(),
                &GroupId::from_slice(&state.scope.group_id()?),
            )
            .map_err(|_| Error::Mls)?
            .ok_or(Error::Changed)?;
            group.set_aad(incoming::commit_aad(&plan)?);
            let messages = group
                .commit_builder()
                .consume_proposal_store(false)
                .force_self_update(true)
                .leaf_node_parameters(
                    LeafNodeParameters::builder()
                        .with_credential_with_key(context.local.credential(now)?)
                        .build(),
                )
                .propose_removals(removed)
                .propose_adds(peers.iter().map(|p| p.package.clone()))
                .load_psks(provider.storage())
                .map_err(|_| Error::Mls)?
                .create_group_info(true)
                .use_ratchet_tree_extension(true)
                .build(provider.rand(), provider.crypto(), &context.local, |_| true)
                .map_err(|_| Error::Mls)?
                .stage_commit(provider)
                .map_err(|_| Error::Mls)?;
            let (commit, welcome, info) = messages.into_messages();
            let commit = commit.to_bytes().map_err(|_| Error::Mls)?;
            let group_info = info.ok_or(Error::Mls)?.to_bytes().map_err(|_| Error::Mls)?;
            let public = self.public_group(provider, &group, Some(&group_info), &context.local)?;
            for member in public.members() {
                let certificate = Certificate::from_credential(&member.credential)?;
                plan.participants
                    .iter_mut()
                    .find(|p| p.device == certificate.device.device)
                    .ok_or(Error::Changed)?
                    .leaf = member.index.u32();
            }
            plan.participants.sort_by_key(|p| p.leaf);
            check_participants(&public, &plan, &context, now)?;
            let tree = public
                .export_ratchet_tree()
                .tls_serialize_detached()
                .map_err(|_| Error::Mls)?;
            plan.context = digest(
                &public
                    .group_context()
                    .tls_serialize_detached()
                    .map_err(|_| Error::Mls)?,
            );
            plan.tree = digest(&tree);
            plan.commit = Some(digest(&commit));
            check_actual(&public, &plan)?;
            let payload = welcome
                .map(|w| w.to_bytes().map_err(|_| Error::Mls))
                .transpose()?;
            if peers.is_empty() != payload.is_none() {
                return Err(Error::Changed);
            }
            let welcomes = plan
                .welcomes
                .iter_mut()
                .map(|w| {
                    let payload = payload.as_ref().ok_or(Error::Changed)?.clone();
                    w.digest = digest(&payload);
                    Ok(Welcome {
                        device: w.device.clone(),
                        incarnation: w.incarnation,
                        key_package: w.key_package,
                        payload,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let transition = Transition {
                certificate: context.certificate.clone(),
                signature: context
                    .local
                    .sign(&plan.signing_bytes()?)
                    .map_err(|_| Error::Mls)?,
                plan,
            };
            transition.verify(now)?;
            let submission = Submission {
                scope: state.scope.clone(),
                operation: request.operation.clone(),
                transition: transition.to_bytes()?,
                commit: Some(commit),
                tree,
                welcomes,
            };
            check_payloads(&submission)?;
            state.pending = Some(Pending {
                created: now,
                intent,
                pins: context.pins_fingerprint,
                own: context.certificate.fingerprint()?,
                submission: submission.clone(),
                group_info: Some(group_info),
            });
            state.clock = now;
            self.record_group_prepared(
                records,
                state.pending.as_ref().ok_or(Error::Changed)?,
                now,
            )?;
            save(records, &state)?;
            Ok(submission)
        })
    }
}
