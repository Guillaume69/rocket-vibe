//! Durable public KeyPackage publication, sharing the real HTTP DTOs.
//! Private HPKE bundles and the exact outbox are committed before any output.
use crate::{
    identity::{self, Certificate, Pins, Root, enrollment::LocalDevice},
    protected::Manager,
    vault::{self, Records},
};
use data_encoding::{BASE64URL_NOPAD as B64, HEXLOWER};
use openmls::{
    ciphersuite::hash_ref::make_key_package_ref,
    prelude::{
        Ciphersuite, KeyPackage, KeyPackageBundle, Lifetime, OpenMlsProvider,
        tls_codec::Serialize as _,
    },
};
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::storage::StorageProvider as _;
use rv_protocol::e2ee::{OperationReceipt, PublishKeyPackages, Scope};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, sync::Arc};

const RECORD: &str = "crypto-packages-v1";
const STATE_LIMIT: usize = 2 * 1024 * 1024;
const PACKAGE_LIMIT: usize = 16 * 1024;
const BATCH_LIMIT: usize = 8;
const RETAINED_LIMIT: usize = 64;
const LIFETIME: u64 = 86400;
const MAX_CLOCK: u64 = 253_402_300_799;
const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error(transparent)]
    Storage(#[from] vault::Error),
    #[error(transparent)]
    Identity(#[from] identity::Error),
    #[error("crypto_package_changed")]
    Changed,
    #[error("crypto_package_pending")]
    Pending,
    #[error("crypto_package_not_pending")]
    NotPending,
    #[error("crypto_package_receipt_mismatch")]
    Receipt,
    #[error("crypto_package_consumed")]
    Consumed,
    #[error("crypto_package_mls_rejected")]
    Mls,
    #[error("crypto_package_limit")]
    Limit,
}
type Result<T> = std::result::Result<T, Error>;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Retained {
    reference: String,
    wire: String,
    created: u64,
    expires: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    created: u64,
    request: PublishKeyPackages,
    expected: OperationReceipt,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    version: u8,
    scope: vault::Scope,
    clock: u64,
    retained: Vec<Retained>,
    pending: Option<Pending>,
    last_receipt: Option<OperationReceipt>,
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn revision(value: &str) -> Result<()> {
    if value.len() > 19 {
        return Err(Error::Changed);
    };
    let parsed: i64 = value.parse().map_err(|_| Error::Changed)?;
    if parsed <= 0 || parsed.to_string() != value {
        return Err(Error::Changed);
    }
    Ok(())
}
fn encoded(value: &str, limit: usize) -> Result<Vec<u8>> {
    if value.len() > limit.div_ceil(3) * 4 {
        return Err(Error::Limit);
    }
    let decoded = B64.decode(value.as_bytes()).map_err(|_| Error::Changed)?;
    if decoded.is_empty() || decoded.len() > limit || B64.encode(&decoded) != value {
        return Err(Error::Changed);
    }
    Ok(decoded)
}
fn same(a: &OperationReceipt, b: &OperationReceipt) -> bool {
    // Exact strings and ordered references, without allocating from a peer DTO.
    a.scope.instance_id == b.scope.instance_id
        && a.scope.data_epoch == b.scope.data_epoch
        && a.operation_id == b.operation_id
        && a.kind == b.kind
        && a.device_id == b.device_id
        && a.incarnation == b.incarnation
        && a.device_revision == b.device_revision
        && a.root_fingerprint == b.root_fingerprint
        && a.key_package_refs == b.key_package_refs
}
fn check_clock(state: &State, now: u64) -> Result<()> {
    if now > MAX_CLOCK || now < state.clock {
        return Err(Error::Changed);
    }
    Ok(())
}
fn save(records: &mut Records, state: &State) -> Result<()> {
    let value = serde_json::to_vec(state).map_err(|_| Error::Changed)?;
    if value.len() > STATE_LIMIT {
        return Err(Error::Limit);
    }
    records.insert(RECORD.into(), value);
    Ok(())
}
fn bundle(provider: &OpenMlsRustCrypto, retained: &Retained) -> Result<Option<KeyPackageBundle>> {
    let bytes = encoded(&retained.wire, PACKAGE_LIMIT)?;
    let reference =
        make_key_package_ref(&bytes, SUITE, provider.crypto()).map_err(|_| Error::Mls)?;
    if B64.encode(reference.as_slice()) != retained.reference {
        return Err(Error::Changed);
    }
    let bundle: Option<KeyPackageBundle> = provider
        .storage()
        .key_package(&reference)
        .map_err(|_| Error::Mls)?;
    if let Some(bundle) = &bundle {
        let package = bundle.key_package();
        let certificate = Certificate::from_credential(package.leaf_node().credential())?;
        certificate.verify(retained.created)?;
        if package.ciphersuite() != SUITE
            || package.last_resort()
            || package.tls_serialize_detached().map_err(|_| Error::Mls)? != bytes
            || package.life_time().not_after() != retained.expires
            || package.life_time().not_before() > retained.created
            || retained.expires > certificate.device.expires_at
            || package.leaf_node().signature_key().as_slice() != certificate.device.signature_key
        {
            return Err(Error::Changed);
        }
    }
    Ok(bundle)
}

/// Run on the same owned worker as the group coordinator, outside UI/network.
/// One pending publication per installation; no private bundle leaves Manager.
pub struct Coordinator {
    manager: Arc<Manager>,
    root: Root,
}
/// Routing metadata for a private receipt query. This is not an accepted ACK.
pub struct PendingLookup {
    pub scope: Scope,
    pub operation_id: String,
}
impl Coordinator {
    pub fn new(manager: Arc<Manager>, root: Root) -> Result<Self> {
        root.validate()?;
        let scope = manager.scope();
        if scope.instance != root.instance
            || scope.user != root.user
            || !identifier(&scope.instance)
            || !identifier(&scope.data_epoch)
            || !identifier(&scope.user)
            || !identifier(&scope.device)
            || HEXLOWER
                .decode(scope.incarnation.as_bytes())
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
    fn read(&self, provider: &OpenMlsRustCrypto, records: &Records) -> Result<Option<State>> {
        let Some(bytes) = records.get(RECORD) else {
            return Ok(None);
        };
        if bytes.len() > STATE_LIMIT {
            return Err(Error::Limit);
        };
        let state: State = serde_json::from_slice(bytes).map_err(|_| Error::Changed)?;
        if state.version != 1
            || state.scope != *self.manager.scope()
            || state.clock > MAX_CLOCK
            || state.retained.len() > RETAINED_LIMIT
        {
            return Err(Error::Changed);
        };
        let mut seen = BTreeSet::new();
        for retained in &state.retained {
            if encoded(&retained.reference, 32)?.len() != 32
                || !seen.insert(&retained.reference)
                || retained.created > state.clock
                || retained.expires <= retained.created
                || retained.expires > MAX_CLOCK
            {
                return Err(Error::Changed);
            };
            if let Some(bundle) = bundle(provider, retained)? {
                self.check_binding(&Certificate::from_credential(
                    bundle.key_package().leaf_node().credential(),
                )?)?;
            }
        }
        if let Some(pending) = &state.pending {
            revision(&pending.request.device_revision)?;
            let request = &pending.request;
            let expected = &pending.expected;
            let references: BTreeSet<_> = expected.key_package_refs.iter().collect();
            if pending.created > state.clock
                || !identifier(&request.operation_id)
                || request.packages.is_empty()
                || request.packages.len() > BATCH_LIMIT
                || expected.key_package_refs.len() != request.packages.len()
                || references.len() != expected.key_package_refs.len()
                || expected.operation_id != request.operation_id
                || expected.device_revision != request.device_revision
                || expected.kind != "publish_key_packages"
                || expected.device_id != state.scope.device
                || expected.incarnation != state.scope.incarnation
                || expected.root_fingerprint != HEXLOWER.encode(&self.root.fingerprint()?)
                || request.scope.instance_id != state.scope.instance
                || request.scope.data_epoch != state.scope.data_epoch
                || expected.scope.instance_id != state.scope.instance
                || expected.scope.data_epoch != state.scope.data_epoch
            {
                return Err(Error::Changed);
            }
            for (wire, reference) in request.packages.iter().zip(&expected.key_package_refs) {
                if !state.retained.iter().any(|r| {
                    r.reference == *reference && r.wire == *wire && r.created == pending.created
                }) {
                    return Err(Error::Changed);
                }
            }
        }
        Ok(Some(state))
    }
    fn check_binding(&self, certificate: &Certificate) -> Result<()> {
        let scope = self.manager.scope();
        let device = &certificate.device;
        if device.root != self.root
            || device.device != scope.device
            || HEXLOWER.encode(&device.incarnation) != scope.incarnation
        {
            return Err(identity::Error::Scope.into());
        }
        Ok(())
    }
    fn local(&self, records: &Records, now: u64) -> Result<(LocalDevice, Certificate)> {
        let local = LocalDevice::load(&self.root, &self.manager.scope().device, records)?;
        let credential = local.credential(now)?;
        let certificate = Certificate::from_credential(&credential.credential)?;
        self.check_binding(&certificate)?;
        Pins::load(records, &self.root.instance)?.check_local(&certificate, now)?;
        Ok((local, certificate))
    }
    fn retry_pending(
        &self,
        provider: &OpenMlsRustCrypto,
        records: &Records,
        state: &State,
        now: u64,
    ) -> Result<PublishKeyPackages> {
        check_clock(state, now)?;
        let (local, _) = self.local(records, now)?;
        let pins = Pins::load(records, &self.root.instance)?;
        let pending = state.pending.as_ref().ok_or(Error::NotPending)?;
        for reference in &pending.expected.key_package_refs {
            let retained = state
                .retained
                .iter()
                .find(|r| r.reference == *reference)
                .ok_or(Error::Changed)?;
            let bundle = bundle(provider, retained)?.ok_or(Error::Consumed)?;
            let package = bundle.key_package();
            let certificate = Certificate::from_credential(package.leaf_node().credential())?;
            pins.check_local(&certificate, now)?;
            if package.leaf_node().signature_key().as_slice() != local.public_key() {
                return Err(Error::Changed);
            };
            if retained.expires <= now || package.life_time().validate().is_err() {
                return Err(identity::Error::Expired.into());
            };
        }
        Ok(pending.request.clone())
    }
    /// `device_revision` comes from the registered device receipt/directory.
    /// Repeated preparation with the same parameters returns the original batch.
    /// IDs are generated inside the vault; callers cannot recycle an old ID.
    pub fn prepare(
        &self,
        device_revision: &str,
        count: usize,
        now: u64,
    ) -> Result<PublishKeyPackages> {
        revision(device_revision)?;
        if count == 0 || count > BATCH_LIMIT {
            return Err(Error::Limit);
        };
        self.transact(|provider, records| {
            let mut state = self.read(provider, records)?.unwrap_or_else(|| State {
                version: 1,
                scope: self.manager.scope().clone(),
                clock: 0,
                retained: vec![],
                pending: None,
                last_receipt: None,
            });
            check_clock(&state, now)?;
            if let Some(pending) = &state.pending {
                if pending.request.device_revision != device_revision
                    || pending.request.packages.len() != count
                {
                    return Err(Error::Pending);
                };
                return self.retry_pending(provider, records, &state, now);
            }
            let (local, certificate) = self.local(records, now)?;
            // A real successful Welcome consumed these bundles in the same vault.
            // Time alone never deletes a key: an accepted Welcome may still be offline.
            let mut retained = Vec::new();
            for entry in state.retained {
                if bundle(provider, &entry)?.is_some() {
                    retained.push(entry)
                };
            }
            state.retained = retained;
            if state.retained.len() + count > RETAINED_LIMIT {
                return Err(Error::Limit);
            };
            let expires = now
                .checked_add(LIFETIME)
                .ok_or(Error::Changed)?
                .min(certificate.device.expires_at);
            let lifetime = Lifetime::init(now.saturating_sub(300), expires);
            if expires <= now || !lifetime.has_acceptable_range() || lifetime.validate().is_err() {
                return Err(identity::Error::Expired.into());
            };
            let mut random = [0; 32];
            getrandom::fill(&mut random).map_err(|_| identity::Error::Unavailable)?;
            let operation = HEXLOWER.encode(&random);
            if state
                .last_receipt
                .as_ref()
                .is_some_and(|r| r.operation_id == operation)
            {
                return Err(Error::Changed);
            };
            let scope = Scope {
                instance_id: state.scope.instance.clone(),
                data_epoch: state.scope.data_epoch.clone(),
            };
            let mut request = PublishKeyPackages {
                scope: scope.clone(),
                operation_id: operation.clone(),
                device_revision: device_revision.into(),
                packages: vec![],
            };
            let mut expected = OperationReceipt {
                scope,
                operation_id: operation,
                kind: "publish_key_packages".into(),
                device_id: state.scope.device.clone(),
                incarnation: state.scope.incarnation.clone(),
                device_revision: device_revision.into(),
                root_fingerprint: HEXLOWER.encode(&self.root.fingerprint()?),
                key_package_refs: vec![],
            };
            for _ in 0..count {
                let package = KeyPackage::builder()
                    .key_package_lifetime(lifetime)
                    .build(SUITE, provider, &local, local.credential(now)?)
                    .map_err(|_| Error::Mls)?;
                let bytes = package
                    .key_package()
                    .tls_serialize_detached()
                    .map_err(|_| Error::Mls)?;
                if bytes.len() > PACKAGE_LIMIT {
                    return Err(Error::Limit);
                };
                let reference = B64.encode(
                    package
                        .key_package()
                        .hash_ref(provider.crypto())
                        .map_err(|_| Error::Mls)?
                        .as_slice(),
                );
                if state.retained.iter().any(|r| r.reference == reference) {
                    return Err(Error::Changed);
                };
                let wire = B64.encode(&bytes);
                request.packages.push(wire.clone());
                expected.key_package_refs.push(reference.clone());
                state.retained.push(Retained {
                    reference,
                    wire,
                    created: now,
                    expires,
                });
            }
            state.clock = now;
            state.pending = Some(Pending {
                created: now,
                request: request.clone(),
                expected,
            });
            save(records, &state)?;
            Ok(request)
        })
    }
    pub fn retry(&self, now: u64) -> Result<PublishKeyPackages> {
        self.inspect(|provider, records| {
            let state = self.read(provider, records)?.ok_or(Error::NotPending)?;
            self.retry_pending(provider, records, &state, now)
        })
    }
    /// Routing metadata for GET operations, never a locally fabricated receipt.
    /// Available even after expiry/revocation or prior consumption by a Welcome.
    pub fn pending_lookup(&self) -> Result<PendingLookup> {
        self.inspect(|provider, records| {
            let pending = self
                .read(provider, records)?
                .ok_or(Error::NotPending)?
                .pending
                .ok_or(Error::NotPending)?;
            Ok(PendingLookup {
                scope: pending.request.scope,
                operation_id: pending.request.operation_id,
            })
        })
    }
    /// An exact historical ACK ends the outbox, without granting new encryption.
    /// Retains private bundles until MLS actually consumes them.
    pub fn confirm(&self, receipt: &OperationReceipt, now: u64) -> Result<()> {
        self.transact(|provider, records| {
            let mut state = self.read(provider, records)?.ok_or(Error::NotPending)?;
            check_clock(&state, now)?;
            if state
                .last_receipt
                .as_ref()
                .is_some_and(|r| same(r, receipt))
            {
                return Ok(());
            };
            let pending = state.pending.as_ref().ok_or(Error::NotPending)?;
            if !same(&pending.expected, receipt) {
                return Err(Error::Receipt);
            };
            state.clock = now;
            state.last_receipt = Some(receipt.clone());
            state.pending = None;
            save(records, &state)
        })
    }
}

#[cfg(test)]
mod tests;
