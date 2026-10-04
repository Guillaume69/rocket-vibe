//! Checked conversions at the HTTP boundary. Metadata never approves a root,
//! device or MLS epoch; Coordinator still performs the protected validation.
use super::*;
use openmls::ciphersuite::hash_ref::make_key_package_ref;
use rv_crypto_public::messages as packet;
use rv_protocol::e2ee as http;

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
fn decimal(value: &str, positive: bool) -> Result<u64> {
    if value.len() > 19 {
        return Err(Error::Limit);
    }
    let parsed: u64 = value.parse().map_err(|_| Error::Changed)?;
    if parsed > i64::MAX as u64 || positive && parsed == 0 || parsed.to_string() != value {
        return Err(Error::Changed);
    }
    Ok(parsed)
}
fn hex<const N: usize>(value: &str) -> Result<[u8; N]> {
    if value.len() != N * 2 {
        return Err(Error::Changed);
    }
    let bytes: [u8; N] = HEXLOWER
        .decode(value.as_bytes())
        .map_err(|_| Error::Changed)?
        .try_into()
        .map_err(|_| Error::Changed)?;
    if bytes == [0; N] || HEXLOWER.encode(&bytes) != value {
        return Err(Error::Changed);
    }
    Ok(bytes)
}
fn decoded(value: &str, limit: usize) -> Result<Vec<u8>> {
    if value.len() > limit.div_ceil(3) * 4 {
        return Err(Error::Limit);
    }
    let bytes = B64.decode(value.as_bytes()).map_err(|_| Error::Changed)?;
    if bytes.len() > limit {
        return Err(Error::Limit);
    }
    if bytes.is_empty() || B64.encode(&bytes) != value {
        return Err(Error::Changed);
    }
    Ok(bytes)
}
pub(super) fn state_transition(value: &http::GroupState) -> Result<Vec<u8>> {
    decoded(&value.transition, public::WIRE_LIMIT)
}
fn http_scope(scope: &Scope) -> http::Scope {
    http::Scope {
        instance_id: scope.instance.clone(),
        data_epoch: scope.data_epoch.clone(),
    }
}
fn same_scope(a: &http::Scope, b: &Scope) -> bool {
    a.instance_id == b.instance && a.data_epoch == b.data_epoch
}
fn bound_scope(value: &http::Scope, room: &str) -> Result<()> {
    if !identifier(&value.instance_id) || !identifier(&value.data_epoch) || !identifier(room) {
        return Err(Error::Changed);
    }
    Ok(())
}

/// Canonical public receipt only. Its authenticity and ownership are checked
/// against the original protected outbox or MLS packet by the coordinator.
pub fn message_receipt(value: &http::ApplicationReceipt) -> Result<packet::Receipt> {
    bound_scope(&value.scope, &value.room_id)?;
    let bytes = decoded(&value.header, packet::PROOF_LIMIT)?;
    let header: packet::Header = serde_json::from_slice(&bytes).map_err(|_| Error::Receipt)?;
    header.validate()?;
    if serde_json::to_vec(&header).map_err(|_| Error::Receipt)? != bytes
        || !same_scope(&value.scope, &header.scope)
        || value.room_id != header.scope.room
        || value.operation_id != header.operation
    {
        return Err(Error::Receipt);
    }
    let receipt = packet::Receipt {
        header,
        fingerprint: hex(&value.fingerprint)?,
        message: value.message_id.clone(),
        position: decimal(&value.position, true)?,
    };
    receipt.validate()?;
    Ok(receipt)
}
pub fn message_receipt_to_wire(value: &packet::Receipt) -> Result<http::ApplicationReceipt> {
    value.validate()?;
    Ok(http::ApplicationReceipt {
        scope: http_scope(&value.header.scope),
        room_id: value.header.scope.room.clone(),
        operation_id: value.header.operation.clone(),
        header: B64.encode(&serde_json::to_vec(&value.header).map_err(|_| Error::Receipt)?),
        fingerprint: HEXLOWER.encode(&value.fingerprint),
        message_id: value.message.clone(),
        position: value.position.to_string(),
    })
}
impl MessageSubmission {
    fn wire_proof(&self) -> Result<packet::Proof> {
        if self.ciphertext.is_empty() || self.ciphertext.len() > packet::CIPHERTEXT_LIMIT {
            return Err(Error::Limit);
        }
        let proof = packet::Proof::from_bytes(&self.proof)?;
        if proof.ciphertext != digest(&self.ciphertext) {
            return Err(Error::Changed);
        }
        Ok(proof)
    }
    /// Bounded, canonical conversion, without granting trust or certificate
    /// lifetime. Historical receipt reconciliation must remain possible.
    pub fn from_wire(value: &http::ApplicationSubmission) -> Result<Self> {
        let submission = Self {
            proof: decoded(&value.proof, packet::PROOF_LIMIT)?,
            ciphertext: decoded(&value.ciphertext, packet::CIPHERTEXT_LIMIT)?,
        };
        let proof = submission.wire_proof()?;
        bound_scope(&value.scope, &proof.header.scope.room)?;
        if !same_scope(&value.scope, &proof.header.scope)
            || value.operation_id != proof.header.operation
        {
            return Err(Error::Changed);
        }
        Ok(submission)
    }
    pub fn to_wire(&self) -> Result<http::ApplicationSubmission> {
        let proof = self.wire_proof()?;
        Ok(http::ApplicationSubmission {
            scope: http_scope(&proof.header.scope),
            operation_id: proof.header.operation,
            proof: B64.encode(&self.proof),
            ciphertext: B64.encode(&self.ciphertext),
        })
    }
    pub fn from_delivered(value: &http::ApplicationMessage) -> Result<(Self, packet::Receipt)> {
        let receipt = message_receipt(&value.receipt)?;
        let submission = Self {
            proof: decoded(&value.proof, packet::PROOF_LIMIT)?,
            ciphertext: decoded(&value.ciphertext, packet::CIPHERTEXT_LIMIT)?,
        };
        receipt.matches(&submission.wire_proof()?)?;
        Ok((submission, receipt))
    }
}
impl Receipt {
    pub fn from_wire(value: &http::GroupReceipt) -> Result<Self> {
        bound_scope(&value.scope, &value.room_id)?;
        if !identifier(&value.operation_id) {
            return Err(Error::Changed);
        }
        let scope = Scope {
            instance: value.scope.instance_id.clone(),
            data_epoch: value.scope.data_epoch.clone(),
            room: value.room_id.clone(),
            incarnation: hex(&value.incarnation)?,
        };
        scope.group_id()?;
        Ok(Self {
            scope,
            operation: value.operation_id.clone(),
            revision: decimal(&value.revision, true)?,
            epoch: decimal(&value.epoch, false)?,
            fingerprint: hex(&value.fingerprint)?,
        })
    }
    pub fn to_wire(&self) -> Result<http::GroupReceipt> {
        self.scope.group_id()?;
        if !identifier(&self.operation)
            || self.revision == 0
            || self.revision > i64::MAX as u64
            || self.epoch > i64::MAX as u64
            || self.fingerprint == [0; 32]
        {
            return Err(Error::Changed);
        }
        Ok(http::GroupReceipt {
            scope: http_scope(&self.scope),
            room_id: self.scope.room.clone(),
            incarnation: HEXLOWER.encode(&self.scope.incarnation),
            operation_id: self.operation.clone(),
            revision: self.revision.to_string(),
            epoch: self.epoch.to_string(),
            fingerprint: HEXLOWER.encode(&self.fingerprint),
        })
    }
    /// Check a public state envelope only. needs_rekey=false is not a private
    /// readiness grant; the vault and current roster remain authoritative.
    pub fn from_state(value: &http::GroupState) -> Result<Self> {
        let receipt = Self::from_wire(&value.receipt)?;
        let transition = Transition::from_bytes(&decoded(&value.transition, public::WIRE_LIMIT)?)?;
        transition.authenticate()?;
        check_receipt(&transition, &receipt)?;
        if transition.plan.tree != digest(&decoded(&value.tree, PAYLOAD_LIMIT)?) {
            return Err(Error::Changed);
        }
        Ok(receipt)
    }
}

fn roster(value: &http::GroupRoster, scope: &Scope) -> Result<Roster> {
    scope.group_id()?;
    if !same_scope(&value.scope, scope)
        || value.room_id != scope.room
        || !identifier(&value.authority_version)
    {
        return Err(Error::Changed);
    }
    if value.members.len() > public::MAX_MEMBERS {
        return Err(Error::Limit);
    }
    if value.members.is_empty() {
        return Err(Error::Changed);
    }
    let mut last: Option<&str> = None;
    for member in &value.members {
        if !identifier(&member.user_id)
            || !identifier(&member.access_version)
            || !identifier(&member.activation_version)
            || last.is_some_and(|u| u >= member.user_id.as_str())
        {
            return Err(Error::Changed);
        }
        last = Some(&member.user_id);
    }
    if let Some(head) = &value.group
        && Receipt::from_wire(head)?.scope != *scope
    {
        return Err(Error::Changed);
    }
    Ok(Roster {
        scope: scope.clone(),
        authority_version: value.authority_version.clone(),
        members: value
            .members
            .iter()
            .map(|m| Member {
                user: m.user_id.clone(),
                access_version: m.access_version.clone(),
                activation_version: m.activation_version.clone(),
            })
            .collect(),
    })
}
fn packages(values: &[http::AvailableKeyPackage], roster: &Roster) -> Result<Vec<Vec<u8>>> {
    if values.len() >= public::MAX_DEVICES {
        return Err(Error::Limit);
    }
    let provider = OpenMlsRustCrypto::default();
    let mut result = Vec::new();
    let mut devices = BTreeSet::new();
    let mut references = BTreeSet::new();
    for value in values {
        if !same_scope(&value.scope, &roster.scope)
            || !identifier(&value.device_id)
            || !roster.members.iter().any(|m| m.user == value.user_id)
            || !devices.insert(&value.device_id)
        {
            return Err(Error::Changed);
        }
        let incarnation = hex::<16>(&value.incarnation)?;
        let reference = decoded(&value.reference, 32)?;
        let bytes = decoded(&value.wire, PACKAGE_LIMIT)?;
        let package = KeyPackageIn::tls_deserialize_exact(&bytes)
            .map_err(|_| Error::Mls)?
            .validate(provider.crypto(), ProtocolVersion::Mls10)
            .map_err(|_| Error::Mls)?;
        let certificate = Certificate::from_credential(package.leaf_node().credential())?;
        certificate.authenticate()?;
        if package.ciphersuite() != SUITE
            || package.last_resort()
            || package.leaf_node().signature_key().as_slice() != certificate.device.signature_key
            || certificate.device.root.instance != roster.scope.instance
            || certificate.device.root.user != value.user_id
            || certificate.device.device != value.device_id
            || certificate.device.incarnation != incarnation
            || make_key_package_ref(&bytes, SUITE, provider.crypto())
                .map_err(|_| Error::Mls)?
                .as_slice()
                != reference
            || !references.insert(reference)
        {
            return Err(Error::Changed);
        }
        result.push(bytes);
    }
    Ok(result)
}
impl Genesis {
    pub fn from_wire(
        value: &http::GroupRoster,
        incarnation: [u8; 16],
        operation: &str,
        available: &[http::AvailableKeyPackage],
    ) -> Result<Self> {
        if value.group.is_some() {
            return Err(Error::Exists);
        }
        if !identifier(operation) {
            return Err(Error::Changed);
        }
        bound_scope(&value.scope, &value.room_id)?;
        let scope = Scope {
            instance: value.scope.instance_id.clone(),
            data_epoch: value.scope.data_epoch.clone(),
            room: value.room_id.clone(),
            incarnation,
        };
        let roster = roster(value, &scope)?;
        let packages = packages(available, &roster)?;
        Ok(Self {
            roster,
            operation: operation.into(),
            packages,
        })
    }
}
impl Change {
    pub fn from_wire(
        value: &http::GroupRoster,
        operation: &str,
        removals: &[String],
        available: &[http::AvailableKeyPackage],
    ) -> Result<Self> {
        if removals.len() >= public::MAX_DEVICES {
            return Err(Error::Limit);
        }
        if removals.iter().any(|d| !identifier(d)) || !identifier(operation) {
            return Err(Error::Changed);
        }
        let head = Receipt::from_wire(value.group.as_ref().ok_or(Error::NotReady)?)?;
        let roster = roster(value, &head.scope)?;
        let packages = packages(available, &roster)?;
        Ok(Self {
            roster,
            head,
            operation: operation.into(),
            removals: removals.to_vec(),
            packages,
        })
    }
}
impl Submission {
    pub fn to_wire(&self) -> Result<http::GroupSubmission> {
        check_payloads(self)?;
        if self.welcomes.len() >= public::MAX_DEVICES {
            return Err(Error::Limit);
        }
        let transition = Transition::from_bytes(&self.transition)?;
        transition.authenticate()?;
        let plan = &transition.plan;
        if self.scope != plan.scope
            || self.operation != plan.operation
            || digest(&self.tree) != plan.tree
            || self.commit.as_deref().map(digest) != plan.commit
            || self.welcomes.len() != plan.welcomes.len()
        {
            return Err(Error::Changed);
        }
        for (actual, expected) in self.welcomes.iter().zip(&plan.welcomes) {
            if actual.device != expected.device
                || actual.incarnation != expected.incarnation
                || actual.key_package != expected.key_package
                || digest(&actual.payload) != expected.digest
            {
                return Err(Error::Changed);
            }
        }
        Ok(http::GroupSubmission {
            scope: http_scope(&self.scope),
            operation_id: self.operation.clone(),
            transition: B64.encode(&self.transition),
            commit: self.commit.as_deref().map(|b| B64.encode(b)),
            tree: B64.encode(&self.tree),
            welcomes: self
                .welcomes
                .iter()
                .map(|w| http::GroupWelcome {
                    device_id: w.device.clone(),
                    incarnation: HEXLOWER.encode(&w.incarnation),
                    key_package_ref: B64.encode(&w.key_package),
                    payload: B64.encode(&w.payload),
                })
                .collect(),
        })
    }
}

pub(super) struct DecodedEvent {
    pub receipt: Receipt,
    pub transition: Vec<u8>,
    pub commit: Option<Vec<u8>>,
    pub welcome: Option<Welcome>,
    previous: Fingerprint,
    expected_epoch: Option<u64>,
}
fn event(value: &http::GroupEvent) -> Result<DecodedEvent> {
    let receipt = Receipt::from_wire(&value.receipt)?;
    let bytes = decoded(&value.transition, public::WIRE_LIMIT)?;
    let transition = Transition::from_bytes(&bytes)?;
    transition.authenticate()?;
    check_receipt(&transition, &receipt)?;
    let commit = value
        .commit
        .as_ref()
        .map(|c| decoded(c, PAYLOAD_LIMIT))
        .transpose()?;
    if transition.plan.commit != commit.as_deref().map(digest) {
        return Err(Error::Changed);
    }
    let welcome = value
        .welcome
        .as_ref()
        .map(|w| {
            if !identifier(&w.device_id) {
                return Err(Error::Changed);
            }
            let incarnation = hex(&w.incarnation)?;
            let key_package = decoded(&w.key_package_ref, 32)?
                .try_into()
                .map_err(|_| Error::Changed)?;
            let payload = decoded(&w.payload, PAYLOAD_LIMIT)?;
            if !transition.plan.welcomes.iter().any(|declared| {
                declared.device == w.device_id
                    && declared.incarnation == incarnation
                    && declared.key_package == key_package
                    && declared.digest == digest(&payload)
            }) {
                return Err(Error::Changed);
            }
            Ok(Welcome {
                device: w.device_id.clone(),
                incarnation,
                key_package,
                payload,
            })
        })
        .transpose()?;
    if commit.as_ref().map_or(0, Vec::len) + welcome.as_ref().map_or(0, |w| w.payload.len())
        > TOTAL_LIMIT
    {
        return Err(Error::Limit);
    }
    Ok(DecodedEvent {
        receipt,
        transition: bytes,
        commit,
        welcome,
        previous: transition.plan.previous,
        expected_epoch: transition.plan.expected_epoch,
    })
}
fn current(value: &http::GroupRoster, receipt: &Receipt) -> Result<Roster> {
    let head = Receipt::from_wire(value.group.as_ref().ok_or(Error::NotReady)?)?;
    if head.scope != receipt.scope
        || head.revision < receipt.revision
        || head.epoch < receipt.epoch
        || head.revision == receipt.revision && head != *receipt
    {
        return Err(Error::Changed);
    }
    roster(value, &receipt.scope)
}
impl Admission {
    pub fn from_wire(roster: &http::GroupRoster, value: &http::GroupEvent) -> Result<Self> {
        let event = event(value)?;
        let admission = Self {
            roster: current(roster, &event.receipt)?,
            receipt: event.receipt,
            transition: event.transition,
            commit: event.commit,
            welcome: event.welcome.ok_or(Error::Changed)?,
        };
        check_admission(&admission)?;
        Ok(admission)
    }
}
impl Commit {
    pub fn from_wire(roster: &http::GroupRoster, value: &http::GroupEvent) -> Result<Self> {
        let event = event(value)?;
        if event.welcome.is_some() {
            return Err(Error::Changed);
        }
        let commit = Self {
            roster: current(roster, &event.receipt)?,
            receipt: event.receipt,
            transition: event.transition,
            commit: event.commit.ok_or(Error::Changed)?,
        };
        incoming::checked(&commit)?;
        Ok(commit)
    }
}
/// Bound and check an ordered page envelope before choosing its targeted
/// admission or successors. Historical grants are checked by the later catchup
/// policy, not silently replaced with the current roster during this decode.
pub fn validate_page(value: &http::GroupEventPage, scope: &Scope, after: u64) -> Result<()> {
    scope.group_id()?;
    if after > i64::MAX as u64 {
        return Err(Error::Changed);
    }
    if value.events.len() > 16 {
        return Err(Error::Limit);
    }
    let mut revision = after;
    let mut total = 0;
    let mut parent = None;
    for value in &value.events {
        let event = event(value)?;
        if event.receipt.scope != *scope
            || Some(event.receipt.revision) != revision.checked_add(1)
            || parent.is_some_and(|(fingerprint, epoch)| {
                event.previous != fingerprint || event.expected_epoch != Some(epoch)
            })
        {
            return Err(Error::Changed);
        }
        revision = event.receipt.revision;
        parent = Some((event.receipt.fingerprint, event.receipt.epoch));
        total += event.transition.len()
            + event.commit.as_ref().map_or(0, Vec::len)
            + event.welcome.as_ref().map_or(0, |w| w.payload.len());
    }
    // Server allows one complete event even when it exceeds the page budget.
    if value.events.len() > 1 && total > TOTAL_LIMIT {
        return Err(Error::Limit);
    }
    if let Some(next) = &value.next
        && (value.events.is_empty() || decimal(next, true)? != revision)
    {
        return Err(Error::Changed);
    }
    Ok(())
}

pub(super) enum DeliveryContent {
    Group(DecodedEvent),
    Message(MessageSubmission, packet::Receipt),
}
pub(super) struct Delivery {
    pub through: u64,
    pub next: Option<u64>,
    pub events: Vec<(u64, DeliveryContent)>,
}
/// Validate the bounded envelope and exact packet labels before any ratchet is
/// spent. Native positions may have gaps; group successors may not.
pub(super) fn delivery(
    page: &http::DeliveryPage,
    scope: &Scope,
    after: u64,
    through: Option<u64>,
) -> Result<Delivery> {
    scope.group_id()?;
    bound_scope(&page.scope, &page.room_id)?;
    let end = decimal(&page.through, false)?;
    if !same_scope(&page.scope, scope)
        || page.room_id != scope.room
        || hex::<16>(&page.incarnation)? != scope.incarnation
        || decimal(&page.after, false)? != after
        || end < after
        || through.is_some_and(|expected| expected != end)
    {
        return Err(Error::JournalOrder);
    }
    if page.events.len() > 16 {
        return Err(Error::Limit);
    }
    let mut position = after;
    let mut total: usize = 0;
    let mut events = Vec::new();
    for frame in &page.events {
        let next_position = decimal(&frame.position, true)?;
        if next_position <= position || next_position > end {
            return Err(Error::JournalOrder);
        }
        let content = match &frame.content {
            http::DeliveryContent::Group(value) => {
                let group = event(value)?;
                if group.receipt.scope != *scope {
                    return Err(Error::JournalOrder);
                }
                total += group.transition.len()
                    + group.commit.as_ref().map_or(0, Vec::len)
                    + group.welcome.as_ref().map_or(0, |w| w.payload.len());
                DeliveryContent::Group(group)
            }
            http::DeliveryContent::Message(value) => {
                let (submission, receipt) = MessageSubmission::from_delivered(value)?;
                if receipt.header.scope != *scope || receipt.position != next_position {
                    return Err(Error::JournalOrder);
                }
                total += submission.proof.len() + submission.ciphertext.len();
                DeliveryContent::Message(submission, receipt)
            }
        };
        if page.events.len() > 1 && total > TOTAL_LIMIT {
            return Err(Error::Limit);
        }
        events.push((next_position, content));
        position = next_position;
    }
    let next = page.next.as_deref().map(|s| decimal(s, true)).transpose()?;
    if next.is_some_and(|next| events.is_empty() || next != position || next >= end) {
        return Err(Error::JournalOrder);
    }
    Ok(Delivery {
        through: end,
        next,
        events,
    })
}
