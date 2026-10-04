//! Protected group preparation. Public delivery ACKs never bypass MLS or pins.
//! The application worker owns these synchronous operations; no UI/network callback
//! runs while the protected vault lease is held.
use crate::{
    identity::{self, Certificate, Fingerprint, Pins, Root, enrollment::LocalDevice},
    protected::Manager,
    vault::{self, Records},
};
use data_encoding::{BASE64URL_NOPAD as B64, HEXLOWER};
use openmls::prelude::{
    Ciphersuite, GroupId, KeyPackage, KeyPackageIn, MlsGroup, MlsGroupCreateConfig,
    MlsGroupJoinConfig, MlsMessageBodyIn, MlsMessageIn, MlsMessageOut, OpenMlsProvider,
    ProcessedWelcome, ProposalStore, ProtocolVersion, PublicGroup,
    tls_codec::{Deserialize as _, Serialize as _},
};
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::signatures::Signer as _;
use rv_crypto_public::groups::{self as public, Member, Participant, Plan, Scope, Transition};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
mod incoming;
pub use incoming::Commit;

const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
const STATE_LIMIT: usize = 8 * 1024 * 1024;
const PAYLOAD_LIMIT: usize = 1024 * 1024;
const TOTAL_LIMIT: usize = 2 * 1024 * 1024;
const PACKAGE_LIMIT: usize = 16 * 1024;
const PACKAGE_HISTORY_LIMIT: usize = 8192;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error(transparent)]
    Storage(#[from] vault::Error),
    #[error(transparent)]
    Identity(#[from] identity::Error),
    #[error("crypto_group_changed")]
    Changed,
    #[error("crypto_group_pending")]
    Pending,
    #[error("crypto_group_exists")]
    Exists,
    #[error("crypto_group_not_ready")]
    NotReady,
    #[error("crypto_group_receipt_mismatch")]
    Receipt,
    #[error("crypto_group_operation_conflict")]
    Conflict,
    #[error("crypto_group_mls_rejected")]
    Mls,
    #[error("crypto_group_limit")]
    Limit,
}
type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Roster {
    pub scope: Scope,
    pub authority_version: String,
    pub members: Vec<Member>,
}
/// Public observations only. Signers and trust decisions come from the vault.
pub struct Genesis {
    pub roster: Roster,
    pub operation: String,
    pub packages: Vec<Vec<u8>>,
}
/// Never serialized/deserialized. The app confirms the exact preview fingerprint.
pub struct Consent {
    fingerprint: Fingerprint,
    intent: Fingerprint,
    state: Fingerprint,
    pins: Fingerprint,
    own: Fingerprint,
    expires: u64,
}
pub struct Preview {
    pub fingerprint: Fingerprint,
    pub scope: Scope,
    pub recipients: Vec<Participant>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Welcome {
    pub device: String,
    pub incarnation: [u8; 16],
    pub key_package: Fingerprint,
    #[serde(with = "bytes")]
    pub payload: Vec<u8>,
}
/// Opaque bytes to adapt to the shared HTTP DTO. No private key/ratchet export.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Submission {
    pub scope: Scope,
    pub operation: String,
    #[serde(with = "bytes")]
    pub transition: Vec<u8>,
    #[serde(with = "optional_bytes")]
    pub commit: Option<Vec<u8>>,
    #[serde(with = "bytes")]
    pub tree: Vec<u8>,
    pub welcomes: Vec<Welcome>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub scope: Scope,
    pub operation: String,
    pub revision: u64,
    pub epoch: u64,
    pub fingerprint: Fingerprint,
}
/// One targeted event, with the current independently observed room grants.
/// Public HTTP metadata alone cannot authorize the join; preview validates MLS.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Admission {
    pub roster: Roster,
    pub receipt: Receipt,
    #[serde(with = "bytes")]
    pub transition: Vec<u8>,
    #[serde(with = "optional_bytes")]
    pub commit: Option<Vec<u8>>,
    pub welcome: Welcome,
}
/// Lookup remains available when a changed pin/expired certificate forbids retry.
pub struct PendingLookup {
    pub scope: Scope,
    pub operation: String,
    pub fingerprint: Fingerprint,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    created: u64,
    intent: Fingerprint,
    pins: Fingerprint,
    own: Fingerprint,
    submission: Submission,
    #[serde(with = "optional_bytes")]
    group_info: Option<Vec<u8>>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Active {
    created: u64,
    transition: Transition,
    receipt: Receipt,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    version: u8,
    scope: Scope,
    clock: u64,
    active: Option<Active>,
    pending: Option<Pending>,
    /// Observed accepted references survive removal of their participant.
    #[serde(default)]
    seen_packages: BTreeSet<Fingerprint>,
}
struct Peer {
    package: KeyPackage,
    certificate: Certificate,
    reference: Fingerprint,
}
struct Context {
    local: LocalDevice,
    certificate: Certificate,
    pins: Pins,
    pins_fingerprint: Fingerprint,
}

fn digest(value: &[u8]) -> Fingerprint {
    Sha256::digest(value).into()
}
fn fingerprint(domain: &str, value: &impl Serialize) -> Result<Fingerprint> {
    let value = serde_json::to_vec(value).map_err(|_| Error::Changed)?;
    let mut hash = Sha256::new();
    hash.update(domain.as_bytes());
    hash.update([0]);
    hash.update(value);
    Ok(hash.finalize().into())
}
fn key(room: &str) -> Result<String> {
    if !rv_crypto_public::label(room) || room.len() > 128 {
        return Err(identity::Error::Scope.into());
    }
    Ok(format!("crypto-group-v1/{room}"))
}
fn read(records: &Records, room: &str) -> Result<Option<State>> {
    let Some(value) = records.get(&key(room)?) else {
        return Ok(None);
    };
    if value.len() > STATE_LIMIT {
        return Err(Error::Limit);
    }
    let mut state: State = serde_json::from_slice(value).map_err(|_| Error::Changed)?;
    if state.version != 1 || state.scope.room != room || state.clock > 253_402_300_799 {
        return Err(Error::Changed);
    }
    state.scope.group_id()?;
    if let Some(active) = &state.active {
        active.transition.verify(active.created)?;
        check_receipt(&active.transition, &active.receipt)?;
        if active.receipt.scope != state.scope || active.created > state.clock {
            return Err(Error::Changed);
        }
        state.seen_packages.extend(
            active
                .transition
                .plan
                .participants
                .iter()
                .filter_map(|p| p.key_package),
        );
    }
    if state.seen_packages.len() > PACKAGE_HISTORY_LIMIT {
        return Err(Error::Limit);
    };
    if let Some(pending) = &state.pending {
        let transition = Transition::from_bytes(&pending.submission.transition)?;
        transition.verify(pending.created)?;
        if transition.plan.scope != state.scope
            || pending.submission.scope != state.scope
            || pending.submission.operation != transition.plan.operation
            || pending.created > state.clock
        {
            return Err(Error::Changed);
        }
        if state.active.as_ref().is_some_and(|active| {
            transition.plan.expected_revision != active.receipt.revision
                || transition.plan.expected_epoch != Some(active.receipt.epoch)
                || transition.plan.previous != active.receipt.fingerprint
        }) || state.active.is_none() && transition.plan.expected_revision != 0
        {
            return Err(Error::Changed);
        }
    }
    Ok(Some(state))
}
fn save(records: &mut Records, state: &State) -> Result<()> {
    if state.seen_packages.len() > PACKAGE_HISTORY_LIMIT {
        return Err(Error::Limit);
    };
    let value = serde_json::to_vec(state).map_err(|_| Error::Changed)?;
    if value.len() > STATE_LIMIT {
        return Err(Error::Limit);
    }
    records.insert(key(&state.scope.room)?, value);
    Ok(())
}
fn check_receipt(transition: &Transition, receipt: &Receipt) -> Result<()> {
    if receipt.scope != transition.plan.scope
        || receipt.operation != transition.plan.operation
        || receipt.revision != transition.plan.expected_revision + 1
        || receipt.epoch != transition.plan.epoch
        || receipt.fingerprint != transition.fingerprint()?
    {
        return Err(Error::Receipt);
    }
    Ok(())
}
fn check_clock(state: Option<&State>, now: u64) -> Result<()> {
    if now > 253_402_300_799 || state.is_some_and(|s| now < s.clock) {
        return Err(Error::Changed);
    }
    Ok(())
}
fn request_fingerprint(request: &Genesis) -> Result<Fingerprint> {
    request.roster.scope.group_id()?;
    if request.roster.members.len() > public::MAX_MEMBERS
        || request.operation.len() > 128
        || request.roster.authority_version.len() > 128
        || request.roster.members.iter().any(|member| {
            member.user.len() > 128
                || member.access_version.len() > 128
                || member.activation_version.len() > 128
        })
        || request.packages.len() >= public::MAX_DEVICES
        || request
            .packages
            .iter()
            .any(|p| p.is_empty() || p.len() > PACKAGE_LIMIT)
    {
        return Err(Error::Limit);
    }
    let mut packages = request
        .packages
        .iter()
        .map(Vec::as_slice)
        .collect::<Vec<_>>();
    packages.sort();
    fingerprint(
        "rocketvibe-local-group-intent-v1",
        &(&request.roster, &request.operation, packages),
    )
}
fn participants(context: &Context, peers: &[Peer]) -> Result<Vec<Participant>> {
    let own = &context.certificate;
    let mut participants = vec![Participant {
        user: own.device.root.user.clone(),
        device: own.device.device.clone(),
        incarnation: own.device.incarnation,
        root: own.device.root.fingerprint()?,
        certificate: own.fingerprint()?,
        leaf: 0,
        key_package: None,
    }];
    for (index, peer) in peers.iter().enumerate() {
        let certificate = &peer.certificate;
        participants.push(Participant {
            user: certificate.device.root.user.clone(),
            device: certificate.device.device.clone(),
            incarnation: certificate.device.incarnation,
            root: certificate.device.root.fingerprint()?,
            certificate: certificate.fingerprint()?,
            leaf: index as u32 + 1,
            key_package: Some(peer.reference),
        });
    }
    Ok(participants)
}
fn draft(request: &Genesis, participants: Vec<Participant>) -> Plan {
    let added = participants.len() > 1;
    let mut welcomes = participants
        .iter()
        .skip(1)
        .map(|p| public::Welcome {
            device: p.device.clone(),
            incarnation: p.incarnation,
            key_package: p.key_package.expect("new peer package"),
            digest: [1; 32],
        })
        .collect::<Vec<_>>();
    welcomes.sort_by(|a, b| a.device.cmp(&b.device));
    Plan {
        version: 1,
        scope: request.roster.scope.clone(),
        operation: request.operation.clone(),
        expected_revision: 0,
        expected_epoch: None,
        epoch: u64::from(added),
        previous: [0; 32],
        authority_version: request.roster.authority_version.clone(),
        members: request.roster.members.clone(),
        participants,
        context: [1; 32],
        commit: added.then_some([1; 32]),
        tree: [1; 32],
        welcomes,
    }
}

/// Account adapter. Every result is released after the protected checkpoint.
/// Genesis, targeted admission, ACK and original retry share this coordinator.
/// Later roster transitions and message delivery remain to integrate before UI.
pub struct Coordinator {
    manager: Arc<Manager>,
    root: Root,
}
impl Coordinator {
    pub fn new(manager: Arc<Manager>, root: Root) -> Result<Self> {
        root.validate()?;
        if manager.scope().instance != root.instance
            || manager.scope().user != root.user
            || HEXLOWER
                .decode(manager.scope().incarnation.as_bytes())
                .ok()
                .is_none_or(|v| v.len() != 16 || v.iter().all(|b| *b == 0))
        {
            return Err(identity::Error::Scope.into());
        }
        Ok(Self { manager, root })
    }
    fn inspect<T>(
        &self,
        operation: impl FnOnce(&OpenMlsRustCrypto, &Records) -> Result<T>,
    ) -> Result<T> {
        let mut failure = None;
        let result = self.manager.inspect(|provider, records| {
            operation(provider, records).map_err(|error| {
                failure = Some(error);
                vault::Error::Rejected
            })
        });
        result.map_err(|error| failure.unwrap_or(Error::Storage(error)))
    }
    fn transact<T>(
        &self,
        operation: impl FnOnce(&OpenMlsRustCrypto, &mut Records) -> Result<T>,
    ) -> Result<T> {
        let mut failure = None;
        let result = self.manager.transact(|provider, records| {
            operation(provider, records).map_err(|error| {
                failure = Some(error);
                vault::Error::Rejected
            })
        });
        result.map_err(|error| failure.unwrap_or(Error::Storage(error)))
    }
    fn context(&self, records: &Records, now: u64) -> Result<Context> {
        let local = LocalDevice::load(&self.root, &self.manager.scope().device, records)?;
        if HEXLOWER.encode(&local.incarnation()) != self.manager.scope().incarnation {
            return Err(identity::Error::Scope.into());
        }
        let credential = local.credential(now)?;
        let certificate = Certificate::from_credential(&credential.credential)?;
        let pins = Pins::load(records, &self.root.instance)?;
        pins.check_local(&certificate, now)?;
        let pins_fingerprint = fingerprint("rocketvibe-local-group-pins-v1", &pins)?;
        Ok(Context {
            local,
            certificate,
            pins,
            pins_fingerprint,
        })
    }
    fn scope(&self, scope: &Scope) -> Result<()> {
        scope.group_id()?;
        if scope.instance != self.manager.scope().instance
            || scope.data_epoch != self.manager.scope().data_epoch
        {
            return Err(identity::Error::Scope.into());
        }
        Ok(())
    }
    fn peers(
        &self,
        provider: &OpenMlsRustCrypto,
        context: &Context,
        packages: &[Vec<u8>],
        now: u64,
    ) -> Result<Vec<Peer>> {
        let mut peers = Vec::new();
        for bytes in packages {
            let package = KeyPackageIn::tls_deserialize_exact(bytes)
                .map_err(|_| Error::Mls)?
                .validate(provider.crypto(), ProtocolVersion::Mls10)
                .map_err(|_| Error::Mls)?;
            context.pins.authorize_key_package(&package, now)?;
            let reference = package
                .hash_ref(provider.crypto())
                .map_err(|_| Error::Mls)?
                .as_slice()
                .try_into()
                .map_err(|_| Error::Mls)?;
            let certificate = Certificate::from_credential(package.leaf_node().credential())?;
            peers.push(Peer {
                package,
                certificate,
                reference,
            });
        }
        peers.sort_by(|a, b| {
            a.certificate
                .device
                .device
                .cmp(&b.certificate.device.device)
        });
        Ok(peers)
    }
    pub fn preview_genesis(&self, request: &Genesis, now: u64) -> Result<(Preview, Consent)> {
        let intent = request_fingerprint(request)?;
        self.scope(&request.roster.scope)?;
        self.inspect(|provider, records| {
            let state = read(records, &request.roster.scope.room)?;
            check_clock(state.as_ref(), now)?;
            if let Some(state) = &state {
                return Err(if state.pending.is_some() {
                    Error::Pending
                } else {
                    Error::Exists
                });
            }
            let context = self.context(records, now)?;
            let peers = self.peers(provider, &context, &request.packages, now)?;
            let recipients = participants(&context, &peers)?;
            draft(request, recipients.clone()).validate()?;
            let own = context.certificate.fingerprint()?;
            let state = fingerprint("rocketvibe-local-group-state-v1", &state)?;
            let expires = peers
                .iter()
                .map(|p| p.certificate.device.expires_at)
                .chain(std::iter::once(context.certificate.device.expires_at))
                .min()
                .unwrap_or(now)
                .min(now.saturating_add(300));
            let fingerprint = fingerprint(
                "rocketvibe-local-group-confirmation-v1",
                &(intent, state, context.pins_fingerprint, own, expires),
            )?;
            Ok((
                Preview {
                    fingerprint,
                    scope: request.roster.scope.clone(),
                    recipients,
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
    pub fn prepare_genesis(
        &self,
        request: &Genesis,
        consent: &Consent,
        confirmed: Fingerprint,
        now: u64,
    ) -> Result<Submission> {
        let intent = request_fingerprint(request)?;
        self.scope(&request.roster.scope)?;
        if confirmed != consent.fingerprint || intent != consent.intent {
            return Err(Error::Changed);
        }
        self.transact(|provider, records| {
            let state = read(records, &request.roster.scope.room)?;
            check_clock(state.as_ref(), now)?;
            if let Some(pending) = state.as_ref().and_then(|s| s.pending.as_ref()) {
                if pending.intent != intent || pending.submission.operation != request.operation {
                    return Err(Error::Conflict);
                }
                return self.retry_pending(provider, records, pending, now);
            }
            if state.is_some() {
                return Err(Error::Exists);
            }
            if fingerprint("rocketvibe-local-group-state-v1", &state)? != consent.state
                || now >= consent.expires
            {
                return Err(Error::Changed);
            }
            let context = self.context(records, now)?;
            if context.pins_fingerprint != consent.pins
                || context.certificate.fingerprint()? != consent.own
            {
                return Err(Error::Changed);
            }
            let peers = self.peers(provider, &context, &request.packages, now)?;
            let mut plan = draft(request, participants(&context, &peers)?);
            plan.validate()?;
            let group_id = GroupId::from_slice(&request.roster.scope.group_id()?);
            if MlsGroup::load(provider.storage(), &group_id)
                .map_err(|_| Error::Mls)?
                .is_some()
            {
                return Err(Error::Changed);
            }
            let mut group = MlsGroup::new_with_group_id(
                provider,
                &context.local,
                &MlsGroupCreateConfig::builder()
                    .ciphersuite(SUITE)
                    .use_ratchet_tree_extension(true)
                    .build(),
                group_id,
                context.local.credential(now)?,
            )
            .map_err(|_| Error::Mls)?;
            let (commit, welcome, group_info) = if peers.is_empty() {
                (None, None, None)
            } else {
                group.set_aad(incoming::commit_aad(&plan)?);
                let (commit, welcome, info) = group
                    .add_members(
                        provider,
                        &context.local,
                        &peers.iter().map(|p| p.package.clone()).collect::<Vec<_>>(),
                    )
                    .map_err(|_| Error::Mls)?;
                let info: MlsMessageOut = info.ok_or(Error::Mls)?.into();
                (
                    Some(commit.to_bytes().map_err(|_| Error::Mls)?),
                    Some(welcome.to_bytes().map_err(|_| Error::Mls)?),
                    Some(info.to_bytes().map_err(|_| Error::Mls)?),
                )
            };
            let public =
                self.public_group(provider, &group, group_info.as_deref(), &context.local)?;
            plan.participants = Self::actual_participants(&public, &context, &peers, now)?;
            plan.context = digest(
                &public
                    .group_context()
                    .tls_serialize_detached()
                    .map_err(|_| Error::Mls)?,
            );
            let tree = public
                .export_ratchet_tree()
                .tls_serialize_detached()
                .map_err(|_| Error::Mls)?;
            plan.tree = digest(&tree);
            plan.commit = commit.as_deref().map(digest);
            plan.epoch = public.group_context().epoch().as_u64();
            let mut welcomes = Vec::new();
            if let Some(payload) = welcome {
                for peer in &peers {
                    welcomes.push(Welcome {
                        device: peer.certificate.device.device.clone(),
                        incarnation: peer.certificate.device.incarnation,
                        key_package: peer.reference,
                        payload: payload.clone(),
                    });
                }
            }
            welcomes.sort_by(|a, b| a.device.cmp(&b.device));
            plan.welcomes = welcomes
                .iter()
                .map(|w| public::Welcome {
                    device: w.device.clone(),
                    incarnation: w.incarnation,
                    key_package: w.key_package,
                    digest: digest(&w.payload),
                })
                .collect();
            plan.validate()?;
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
                scope: request.roster.scope.clone(),
                operation: request.operation.clone(),
                transition: transition.to_bytes()?,
                commit,
                tree,
                welcomes,
            };
            check_payloads(&submission)?;
            save(
                records,
                &State {
                    version: 1,
                    scope: request.roster.scope.clone(),
                    clock: now,
                    active: None,
                    seen_packages: BTreeSet::new(),
                    pending: Some(Pending {
                        created: now,
                        intent,
                        pins: context.pins_fingerprint,
                        own: context.certificate.fingerprint()?,
                        submission: submission.clone(),
                        group_info,
                    }),
                },
            )?;
            Ok(submission)
        })
    }
    fn public_group(
        &self,
        provider: &OpenMlsRustCrypto,
        group: &MlsGroup,
        info: Option<&[u8]>,
        local: &LocalDevice,
    ) -> Result<PublicGroup> {
        let tree = match group.pending_commit() {
            Some(p) => p
                .export_ratchet_tree(provider.crypto(), group.export_ratchet_tree())
                .map_err(|_| Error::Mls)?
                .ok_or(Error::Mls)?,
            None => group.export_ratchet_tree(),
        };
        let info = match info {
            Some(value) => value.to_vec(),
            None => group
                .export_group_info(provider.crypto(), local, true)
                .map_err(|_| Error::Mls)?
                .to_bytes()
                .map_err(|_| Error::Mls)?,
        };
        let message = MlsMessageIn::tls_deserialize_exact(info).map_err(|_| Error::Mls)?;
        let MlsMessageBodyIn::GroupInfo(info) = message.extract() else {
            return Err(Error::Mls);
        };
        let verifier = OpenMlsRustCrypto::default();
        let (public, _) = PublicGroup::from_external(
            verifier.crypto(),
            verifier.storage(),
            tree.into(),
            info,
            ProposalStore::new(),
        )
        .map_err(|_| Error::Mls)?;
        Ok(public)
    }
    fn actual_participants(
        group: &PublicGroup,
        context: &Context,
        peers: &[Peer],
        now: u64,
    ) -> Result<Vec<Participant>> {
        let expected = participants(context, peers)?;
        let expected: BTreeMap<_, _> = expected
            .into_iter()
            .map(|p| (p.device.clone(), p))
            .collect();
        let mut result = Vec::new();
        for member in group.members() {
            let certificate = Certificate::from_credential(&member.credential)?;
            certificate.verify(now)?;
            if certificate.device.device != context.certificate.device.device {
                context.pins.authorize_credential(
                    &member.credential,
                    &member.signature_key,
                    now,
                )?;
            }
            let mut participant = expected
                .get(&certificate.device.device)
                .ok_or(Error::Changed)?
                .clone();
            if certificate.fingerprint()? != participant.certificate
                || member.signature_key.as_slice() != certificate.device.signature_key
            {
                return Err(Error::Changed);
            }
            participant.leaf = member.index.u32();
            result.push(participant);
        }
        if result.len() != expected.len() {
            return Err(Error::Changed);
        }
        result.sort_by_key(|p| p.leaf);
        Ok(result)
    }
    fn retry_pending(
        &self,
        provider: &OpenMlsRustCrypto,
        records: &Records,
        pending: &Pending,
        now: u64,
    ) -> Result<Submission> {
        let context = self.context(records, now)?;
        if context.pins_fingerprint != pending.pins
            || context.certificate.fingerprint()? != pending.own
        {
            return Err(Error::Changed);
        }
        let transition = Transition::from_bytes(&pending.submission.transition)?;
        transition.verify(now)?;
        self.scope(&transition.plan.scope)?;
        check_payloads(&pending.submission)?;
        let group = MlsGroup::load(
            provider.storage(),
            &GroupId::from_slice(&transition.plan.scope.group_id()?),
        )
        .map_err(|_| Error::Mls)?
        .ok_or(Error::Changed)?;
        let public = self.public_group(
            provider,
            &group,
            pending.group_info.as_deref(),
            &context.local,
        )?;
        check_actual(&public, &transition.plan)?;
        for member in public.members() {
            if Certificate::from_credential(&member.credential)?
                .device
                .device
                != context.certificate.device.device
            {
                context.pins.authorize_credential(
                    &member.credential,
                    &member.signature_key,
                    now,
                )?;
            }
        }
        Ok(pending.submission.clone())
    }
    pub fn retry(&self, room: &str, now: u64) -> Result<Submission> {
        self.inspect(|provider, records| {
            let state = read(records, room)?.ok_or(Error::NotReady)?;
            check_clock(Some(&state), now)?;
            self.retry_pending(
                provider,
                records,
                state.pending.as_ref().ok_or(Error::NotReady)?,
                now,
            )
        })
    }
    pub fn pending_lookup(&self, room: &str) -> Result<PendingLookup> {
        self.inspect(|_, records| {
            let state = read(records, room)?.ok_or(Error::NotReady)?;
            self.scope(&state.scope)?;
            let pending = state.pending.ok_or(Error::NotReady)?;
            let transition = Transition::from_bytes(&pending.submission.transition)?;
            Ok(PendingLookup {
                scope: state.scope,
                operation: pending.submission.operation,
                fingerprint: transition.fingerprint()?,
            })
        })
    }
    /// Validate a real Welcome in a disposable provider snapshot. Package
    /// consumption in OpenMLS is discarded until the confirmed transaction.
    pub fn preview_admission(&self, admission: &Admission, now: u64) -> Result<(Preview, Consent)> {
        let (transition, intent) = check_admission(admission)?;
        self.scope(&transition.plan.scope)?;
        self.inspect(|provider, records| {
            let state = read(records, &transition.plan.scope.room)?;
            check_clock(state.as_ref(), now)?;
            if let Some(state) = &state {
                return Err(if state.pending.is_some() {
                    Error::Pending
                } else {
                    Error::Exists
                });
            }
            let context = self.context(records, now)?;
            let recipients_expire =
                self.validate_admission(provider, &context, admission, &transition, now)?;
            let own = context.certificate.fingerprint()?;
            let state = fingerprint("rocketvibe-local-group-state-v1", &state)?;
            let expires = recipients_expire
                .min(
                    transition
                        .certificate
                        .device
                        .expires_at
                        .min(context.certificate.device.expires_at),
                )
                .min(now.saturating_add(300));
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
    /// Accept only the exact validated preview, atomically with consumption of
    /// the private package. A lost checkpoint is reconciled by this same input.
    pub fn accept_admission(
        &self,
        admission: &Admission,
        consent: &Consent,
        confirmed: Fingerprint,
        now: u64,
    ) -> Result<()> {
        let (transition, intent) = check_admission(admission)?;
        self.scope(&transition.plan.scope)?;
        if intent != consent.intent || confirmed != consent.fingerprint {
            return Err(Error::Changed);
        }
        self.transact(|provider, records| {
            let state = read(records, &transition.plan.scope.room)?;
            check_clock(state.as_ref(), now)?;
            if let Some(state) = &state {
                if state.pending.is_some() {
                    return Err(Error::Pending);
                }
                if let Some(active) = &state.active {
                    if active.receipt != admission.receipt || active.transition != transition {
                        return Err(Error::Exists);
                    }
                    let group = MlsGroup::load(
                        provider.storage(),
                        &GroupId::from_slice(&state.scope.group_id()?),
                    )
                    .map_err(|_| Error::Mls)?
                    .ok_or(Error::Changed)?;
                    // Historical reconciliation is not a fresh encryption grant.
                    return check_actual(group.public_group(), &active.transition.plan);
                }
                return Err(Error::Changed);
            }
            if now >= consent.expires
                || fingerprint("rocketvibe-local-group-state-v1", &state)? != consent.state
            {
                return Err(Error::Changed);
            }
            let context = self.context(records, now)?;
            if context.pins_fingerprint != consent.pins
                || context.certificate.fingerprint()? != consent.own
            {
                return Err(Error::Changed);
            }
            self.validate_admission(provider, &context, admission, &transition, now)?;
            let seen_packages = transition
                .plan
                .participants
                .iter()
                .filter_map(|p| p.key_package)
                .collect();
            save(
                records,
                &State {
                    version: 1,
                    scope: transition.plan.scope.clone(),
                    clock: now,
                    pending: None,
                    seen_packages,
                    active: Some(Active {
                        created: now,
                        transition,
                        receipt: admission.receipt.clone(),
                    }),
                },
            )
        })
    }
    fn validate_admission(
        &self,
        provider: &OpenMlsRustCrypto,
        context: &Context,
        admission: &Admission,
        transition: &Transition,
        now: u64,
    ) -> Result<u64> {
        transition.verify(now)?;
        let welcome = &admission.welcome;
        if welcome.device != context.certificate.device.device
            || welcome.incarnation != context.local.incarnation()
        {
            return Err(identity::Error::Scope.into());
        }
        let group_id = GroupId::from_slice(&transition.plan.scope.group_id()?);
        if MlsGroup::load(provider.storage(), &group_id)
            .map_err(|_| Error::Mls)?
            .is_some()
        {
            return Err(Error::Changed);
        }
        let message =
            MlsMessageIn::tls_deserialize_exact(&welcome.payload).map_err(|_| Error::Mls)?;
        let MlsMessageBodyIn::Welcome(message) = message.extract() else {
            return Err(Error::Mls);
        };
        if message.ciphersuite() != SUITE {
            return Err(Error::Mls);
        }
        let processed = ProcessedWelcome::new_from_welcome(
            provider,
            &MlsGroupJoinConfig::builder()
                .use_ratchet_tree_extension(true)
                .build(),
            message,
        )
        .map_err(|_| Error::Mls)?;
        let package = processed.own_key_package().ok_or(Error::Mls)?;
        if package.last_resort()
            || package
                .hash_ref(provider.crypto())
                .map_err(|_| Error::Mls)?
                .as_slice()
                != welcome.key_package
        {
            return Err(Error::Changed);
        }
        let certificate = Certificate::from_credential(package.leaf_node().credential())?;
        if certificate != context.certificate
            || package.leaf_node().signature_key().as_slice() != context.local.public_key()
        {
            return Err(Error::Changed);
        }
        let staged = processed
            .into_staged_welcome(provider, None)
            .map_err(|_| Error::Mls)?;
        let sender = staged.welcome_sender().map_err(|_| Error::Mls)?;
        let author = transition.certificate.fingerprint()?;
        if Certificate::from_credential(sender.credential())? != transition.certificate
            || sender.signature_key().as_slice() != transition.certificate.device.signature_key
            || !transition
                .plan
                .participants
                .iter()
                .any(|p| p.leaf == staged.welcome_sender_index().u32() && p.certificate == author)
        {
            return Err(Error::Changed);
        }
        let own_leaf = staged.own_leaf_index().u32();
        let group = staged.into_group(provider).map_err(|_| Error::Mls)?;
        if group.ciphersuite() != SUITE {
            return Err(Error::Mls);
        }
        check_actual(group.public_group(), &transition.plan)?;
        let expires = check_participants(group.public_group(), &transition.plan, context, now)?;
        if !transition.plan.participants.iter().any(|p| {
            p.device == welcome.device
                && p.leaf == own_leaf
                && p.key_package == Some(welcome.key_package)
        }) {
            return Err(Error::Changed);
        }
        Ok(expires)
    }
    pub fn confirm(&self, receipt: &Receipt, now: u64) -> Result<()> {
        self.scope(&receipt.scope)?;
        self.transact(|provider, records| {
            let mut state = read(records, &receipt.scope.room)?.ok_or(Error::NotReady)?;
            check_clock(Some(&state), now)?;
            if state.scope != receipt.scope {
                return Err(Error::Receipt);
            }
            if let Some(active) = &state.active {
                if active.receipt == *receipt {
                    return Ok(());
                };
                if state.pending.is_none() {
                    return Err(Error::Receipt);
                };
            }
            let pending = state.pending.as_ref().ok_or(Error::NotReady)?;
            let transition = Transition::from_bytes(&pending.submission.transition)?;
            check_receipt(&transition, receipt)?;
            let mut group = MlsGroup::load(
                provider.storage(),
                &GroupId::from_slice(&state.scope.group_id()?),
            )
            .map_err(|_| Error::Mls)?
            .ok_or(Error::Changed)?;
            if transition.plan.epoch > 0 {
                group
                    .merge_pending_commit(provider)
                    .map_err(|_| Error::Mls)?;
            }
            check_actual(group.public_group(), &transition.plan)?;
            state.seen_packages.extend(
                transition
                    .plan
                    .participants
                    .iter()
                    .filter_map(|p| p.key_package),
            );
            state.active = Some(Active {
                created: pending.created,
                transition,
                receipt: receipt.clone(),
            });
            state.pending = None;
            state.clock = now;
            save(records, &state)
        })
    }
    pub fn ready_epoch(&self, room: &str) -> Result<u64> {
        self.inspect(|provider, records| {
            let state = read(records, room)?.ok_or(Error::NotReady)?;
            self.scope(&state.scope)?;
            let active = state.active.ok_or(Error::NotReady)?;
            let group = MlsGroup::load(
                provider.storage(),
                &GroupId::from_slice(&state.scope.group_id()?),
            )
            .map_err(|_| Error::Mls)?
            .ok_or(Error::Changed)?;
            check_actual(group.public_group(), &active.transition.plan)?;
            Ok(group.epoch().as_u64())
        })
    }
}
fn check_admission(admission: &Admission) -> Result<(Transition, Fingerprint)> {
    let welcome = &admission.welcome;
    if admission.transition.len() > public::WIRE_LIMIT
        || welcome.payload.is_empty()
        || welcome.payload.len() > PAYLOAD_LIMIT
        || admission
            .commit
            .as_ref()
            .is_some_and(|v| v.is_empty() || v.len() > PAYLOAD_LIMIT)
        || welcome.payload.len() + admission.commit.as_ref().map_or(0, Vec::len) > TOTAL_LIMIT
    {
        return Err(Error::Limit);
    }
    let transition = Transition::from_bytes(&admission.transition)?;
    transition.plan.validate()?;
    check_receipt(&transition, &admission.receipt)?;
    if transition.plan.scope != admission.roster.scope
        || transition.plan.authority_version != admission.roster.authority_version
        || transition.plan.members != admission.roster.members
        || transition.plan.commit != admission.commit.as_deref().map(digest)
        || !transition.plan.welcomes.iter().any(|w| {
            w.device == welcome.device
                && w.incarnation == welcome.incarnation
                && w.key_package == welcome.key_package
                && w.digest == digest(&welcome.payload)
        })
    {
        return Err(Error::Changed);
    }
    let intent = fingerprint("rocketvibe-local-group-admission-v1", admission)?;
    Ok((transition, intent))
}
fn check_participants(
    group: &PublicGroup,
    plan: &Plan,
    context: &Context,
    now: u64,
) -> Result<u64> {
    let expected: BTreeMap<_, _> = plan.participants.iter().map(|p| (p.leaf, p)).collect();
    let mut count = 0;
    let mut expires = u64::MAX;
    for member in group.members() {
        count += 1;
        let certificate = Certificate::from_credential(&member.credential)?;
        certificate.verify(now)?;
        expires = expires.min(certificate.device.expires_at);
        let participant = expected.get(&member.index.u32()).ok_or(Error::Changed)?;
        let device = &certificate.device;
        if device.root.instance != plan.scope.instance
            || device.root.user != participant.user
            || device.device != participant.device
            || device.incarnation != participant.incarnation
            || device.root.fingerprint()? != participant.root
            || certificate.fingerprint()? != participant.certificate
            || member.signature_key.as_slice() != device.signature_key
        {
            return Err(Error::Changed);
        }
        if device.device == context.certificate.device.device {
            if certificate != context.certificate {
                return Err(Error::Changed);
            }
        } else {
            context
                .pins
                .authorize_credential(&member.credential, &member.signature_key, now)?;
        }
    }
    if count != expected.len() {
        return Err(Error::Changed);
    }
    Ok(expires)
}
fn check_actual(group: &PublicGroup, plan: &Plan) -> Result<()> {
    if group.group_context().group_id().as_slice() != plan.scope.group_id()?
        || group.group_context().epoch().as_u64() != plan.epoch
        || digest(
            &group
                .group_context()
                .tls_serialize_detached()
                .map_err(|_| Error::Mls)?,
        ) != plan.context
        || digest(
            &group
                .export_ratchet_tree()
                .tls_serialize_detached()
                .map_err(|_| Error::Mls)?,
        ) != plan.tree
    {
        return Err(Error::Changed);
    }
    Ok(())
}
fn check_payloads(submission: &Submission) -> Result<()> {
    let mut total = submission.tree.len() + submission.commit.as_ref().map_or(0, Vec::len);
    if submission.tree.is_empty()
        || submission.tree.len() > PAYLOAD_LIMIT
        || submission
            .commit
            .as_ref()
            .is_some_and(|v| v.is_empty() || v.len() > PAYLOAD_LIMIT)
        || submission.transition.len() > public::WIRE_LIMIT
    {
        return Err(Error::Limit);
    }
    for welcome in &submission.welcomes {
        if welcome.payload.is_empty() || welcome.payload.len() > PAYLOAD_LIMIT {
            return Err(Error::Limit);
        }
        total += welcome.payload.len();
    }
    if total > TOTAL_LIMIT {
        return Err(Error::Limit);
    }
    Ok(())
}
mod bytes {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        value: &[u8],
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&B64.encode(value))
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Vec<u8>, D::Error> {
        let value = String::deserialize(deserializer)?;
        B64.decode(value.as_bytes())
            .map_err(serde::de::Error::custom)
    }
}
mod optional_bytes {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        value: &Option<Vec<u8>>,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        value.as_ref().map(|b| B64.encode(b)).serialize(serializer)
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Option<Vec<u8>>, D::Error> {
        Option::<String>::deserialize(deserializer)?
            .map(|v| B64.decode(v.as_bytes()).map_err(serde::de::Error::custom))
            .transpose()
    }
}

#[cfg(test)]
mod tests;
