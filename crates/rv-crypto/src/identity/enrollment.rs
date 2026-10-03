//! Signed enrollment requests, local approval and durable original grants.
//! These operations belong inside the protected transaction, never HTTP handlers.
use super::{Certificate, Error, Fingerprint, Issuer, Root, label, random, signing_bytes};
use crate::vault::Records;
use ed25519_dalek::{Signer as _, SigningKey};
use openmls::prelude::CredentialWithKey;
use openmls_traits::{
    signatures::{Signer, SignerError},
    types::SignatureScheme,
};
pub use rv_crypto_public::enrollment::{Grant, Request, RequestBody};
use rv_crypto_public::enrollment::{REQUEST_DOMAIN, REQUEST_LIFETIME};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use zeroize::{Zeroize, Zeroizing};
const DEVICE_RECORD: &str = "crypto-device-v1";
const ISSUANCE_RECORD: &str = "crypto-issuance-v1";
const MAX_RECEIPTS: usize = 256;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceState {
    version: u8,
    root: Root,
    device: String,
    incarnation: [u8; 16],
    seed: [u8; 32],
    pending: Option<Request>,
    grant: Option<Grant>,
}
impl Drop for DeviceState {
    fn drop(&mut self) {
        self.seed.zeroize();
    }
}
/// A fresh leaf key, never a root key. No Clone/Debug/plaintext export.
/// Load and use it only inside the owned protected-storage operation.
pub struct LocalDevice {
    state: DeviceState,
    signing: SigningKey,
    persisted: Option<Fingerprint>,
}
impl LocalDevice {
    /// Explicit fresh incarnation. Existing state is never overwritten.
    pub fn create(root: &Root, device: &str, records: &mut Records) -> Result<Self, Error> {
        root.validate()?;
        if !label(device) {
            return Err(Error::Scope);
        }
        if records.contains_key(DEVICE_RECORD) {
            return Err(Error::Changed);
        }
        let seed = Zeroizing::new(random()?);
        let state = DeviceState {
            version: 1,
            root: root.clone(),
            device: device.into(),
            incarnation: random()?,
            seed: *seed,
            pending: None,
            grant: None,
        };
        let mut local = Self {
            state,
            signing: SigningKey::from_bytes(&seed),
            persisted: None,
        };
        local.save(records)?;
        Ok(local)
    }
    pub fn load(root: &Root, device: &str, records: &Records) -> Result<Self, Error> {
        let bytes = records.get(DEVICE_RECORD).ok_or(Error::Unapproved)?;
        if bytes.len() > 3 * super::WIRE_LIMIT {
            return Err(Error::Limit);
        }
        let state: DeviceState = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
        if state.version != 1 || state.root != *root || state.device != device {
            return Err(Error::Scope);
        }
        root.validate()?;
        if !label(device) || state.incarnation == [0; 16] {
            return Err(Error::Invalid);
        }
        let signing = SigningKey::from_bytes(&state.seed);
        let local = Self {
            state,
            signing,
            persisted: Some(Sha256::digest(bytes).into()),
        };
        if let Some(request) = &local.state.pending {
            request.verify(request.body.issued_at)?;
            local.matches_request(request)?;
        }
        if let Some(grant) = &local.state.grant {
            grant.verify(grant.certificate.device.issued_at)?;
            local.matches_certificate(&grant.certificate)?;
        }
        Ok(local)
    }
    pub fn incarnation(&self) -> [u8; 16] {
        self.state.incarnation
    }
    pub fn public_key(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }
    fn matches_request(&self, request: &Request) -> Result<(), Error> {
        let body = &request.body;
        if body.root != self.state.root
            || body.device != self.state.device
            || body.incarnation != self.state.incarnation
            || body.signature_key != self.public_key()
        {
            return Err(Error::Changed);
        }
        Ok(())
    }
    fn matches_certificate(&self, certificate: &Certificate) -> Result<(), Error> {
        let body = &certificate.device;
        if body.root != self.state.root
            || body.device != self.state.device
            || body.incarnation != self.state.incarnation
            || body.signature_key != self.public_key()
        {
            return Err(Error::Changed);
        }
        Ok(())
    }
    fn current(&self, records: &Records) -> Result<(), Error> {
        let current = records.get(DEVICE_RECORD).map(|b| Sha256::digest(b).into());
        if current != self.persisted {
            return Err(Error::Changed);
        }
        Ok(())
    }
    fn save(&mut self, records: &mut Records) -> Result<(), Error> {
        self.current(records)?;
        let bytes = Zeroizing::new(serde_json::to_vec(&self.state).map_err(|_| Error::Invalid)?);
        if bytes.len() > 3 * super::WIRE_LIMIT {
            return Err(Error::Limit);
        }
        self.persisted = Some(Sha256::digest(&bytes).into());
        records.insert(DEVICE_RECORD.into(), bytes.to_vec());
        Ok(())
    }
    /// Persist the exact request before making it available to delivery.
    /// A retry reuses its ID, proof and expiration; it does not extend the lease.
    pub fn request(&mut self, now: u64, records: &mut Records) -> Result<Request, Error> {
        self.current(records)?;
        if let Some(request) = &self.state.pending {
            match request.verify(now) {
                Ok(()) => return Ok(request.clone()),
                Err(Error::Expired) if now >= request.body.expires_at => (),
                Err(error) => return Err(error),
            }
        }
        let body = RequestBody {
            version: 1,
            root: self.state.root.clone(),
            device: self.state.device.clone(),
            incarnation: self.state.incarnation,
            request_id: random()?,
            signature_key: self.public_key(),
            issued_at: now,
            expires_at: now.checked_add(REQUEST_LIFETIME).ok_or(Error::Invalid)?,
        };
        let request = Request {
            signature: self
                .signing
                .sign(&signing_bytes(REQUEST_DOMAIN, &body)?)
                .to_bytes()
                .to_vec(),
            body,
        };
        request.verify(now)?;
        self.state.pending = Some(request.clone());
        self.save(records)?;
        Ok(request)
    }
    /// Grant + pending-request binding, then atomic private persistence.
    /// Pins and room membership are independent; this alone cannot add a leaf.
    pub fn install(&mut self, grant: &Grant, now: u64, records: &mut Records) -> Result<(), Error> {
        self.current(records)?;
        grant.verify(now)?;
        self.matches_certificate(&grant.certificate)?;
        if self.state.grant.as_ref() == Some(grant) {
            return Ok(());
        }
        let pending = self.state.pending.as_ref().ok_or(Error::Unapproved)?;
        pending.verify(now)?;
        if pending.fingerprint()? != grant.request
            || grant.certificate.device.issued_at < pending.body.issued_at
        {
            return Err(Error::Changed);
        }
        self.state.grant = Some(grant.clone());
        self.state.pending = None;
        self.save(records)
    }
    pub fn credential(&self, now: u64) -> Result<CredentialWithKey, Error> {
        let grant = self.state.grant.as_ref().ok_or(Error::Unapproved)?;
        grant.verify(now)?;
        Ok(CredentialWithKey {
            credential: grant.certificate.credential()?,
            signature_key: self.public_key().to_vec().into(),
        })
    }
}
impl Signer for LocalDevice {
    fn sign(&self, payload: &[u8]) -> Result<Vec<u8>, SignerError> {
        Ok(self.signing.sign(payload).to_bytes().to_vec())
    }
    fn signature_scheme(&self) -> SignatureScheme {
        SignatureScheme::ED25519
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    id: [u8; 32],
    expires_at: u64,
    grant: Grant,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    version: u8,
    root: Fingerprint,
    clock: u64,
    receipts: Vec<Receipt>,
}
impl Ledger {
    fn load(root: &Root, records: &Records) -> Result<Self, Error> {
        let fingerprint = root.fingerprint()?;
        let Some(bytes) = records.get(ISSUANCE_RECORD) else {
            return Ok(Self {
                version: 1,
                root: fingerprint,
                clock: 0,
                receipts: Vec::new(),
            });
        };
        if bytes.len() > super::STATE_LIMIT {
            return Err(Error::Limit);
        }
        let ledger: Self = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
        if ledger.version != 1
            || ledger.root != fingerprint
            || ledger.receipts.len() > MAX_RECEIPTS
            || ledger.clock > 253_402_300_799
        {
            return Err(Error::Changed);
        }
        let mut ids = BTreeSet::new();
        for receipt in &ledger.receipts {
            if receipt.id == [0; 32]
                || !ids.insert(receipt.id)
                || receipt.grant.certificate.device.root != *root
                || receipt.expires_at <= receipt.grant.certificate.device.issued_at
                || receipt.expires_at > 253_402_300_799
                || receipt.grant.certificate.device.issued_at > ledger.clock
            {
                return Err(Error::Invalid);
            }
            receipt
                .grant
                .verify(receipt.grant.certificate.device.issued_at)?;
        }
        Ok(ledger)
    }
    fn bytes(&self) -> Result<Vec<u8>, Error> {
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if bytes.len() > super::STATE_LIMIT {
            return Err(Error::Limit);
        }
        Ok(bytes)
    }
    fn fingerprint(&self) -> Result<Fingerprint, Error> {
        Ok(Sha256::digest(self.bytes()?).into())
    }
    fn save(&self, records: &mut Records) -> Result<(), Error> {
        records.insert(ISSUANCE_RECORD.into(), self.bytes()?);
        Ok(())
    }
}
/// Opaque local preview; cannot come from a network response.
/// The app also fences the active viewer account / data epoch / UI generation.
pub struct IssuanceConsent {
    request: Fingerprint,
    root: Fingerprint,
    ledger: Fingerprint,
    expires_at: u64,
}
impl Issuer {
    pub fn preview_request(
        &self,
        request: &Request,
        now: u64,
        valid_for: u64,
        records: &Records,
    ) -> Result<IssuanceConsent, Error> {
        request.verify(now)?;
        if request.body.root != self.root {
            return Err(Error::Changed);
        }
        if valid_for == 0 || valid_for > super::MAX_LIFETIME {
            return Err(Error::Invalid);
        }
        let expires_at = now
            .checked_add(valid_for)
            .filter(|v| *v <= 253_402_300_799)
            .ok_or(Error::Invalid)?;
        let ledger = Ledger::load(&self.root, records)?;
        if now < ledger.clock {
            return Err(Error::Expired);
        }
        Ok(IssuanceConsent {
            request: request.fingerprint()?,
            root: self.root.fingerprint()?,
            ledger: ledger.fingerprint()?,
            expires_at,
        })
    }
    /// Call only after human approval of this exact preview, inside the protected
    /// transaction. A valid HTTP session or proof alone never invokes this method.
    pub fn approve_request(
        &self,
        request: &Request,
        consent: &IssuanceConsent,
        now: u64,
        records: &mut Records,
    ) -> Result<Grant, Error> {
        request.verify(now)?;
        if request.body.root != self.root
            || request.fingerprint()? != consent.request
            || self.root.fingerprint()? != consent.root
        {
            return Err(Error::Changed);
        }
        let mut ledger = Ledger::load(&self.root, records)?;
        if now < ledger.clock {
            return Err(Error::Expired);
        }
        if let Some(receipt) = ledger
            .receipts
            .iter()
            .find(|r| r.id == request.body.request_id)
        {
            if receipt.grant.request != consent.request {
                return Err(Error::Changed);
            }
            receipt.grant.verify(now)?;
            return Ok(receipt.grant.clone());
        }
        if ledger.fingerprint()? != consent.ledger {
            return Err(Error::Changed);
        }
        if consent.expires_at <= now {
            return Err(Error::Expired);
        }
        ledger.receipts.retain(|r| r.expires_at > now);
        if ledger.receipts.len() >= MAX_RECEIPTS {
            return Err(Error::Limit);
        }
        let body = &request.body;
        let certificate = self.certify(
            &body.device,
            body.incarnation,
            body.signature_key,
            now,
            consent.expires_at,
        )?;
        let mut grant = Grant {
            request: consent.request,
            certificate,
            signature: Vec::new(),
        };
        grant.signature = self.signing.sign(&grant.body()?).to_bytes().to_vec();
        grant.verify(now)?;
        ledger.receipts.push(Receipt {
            id: body.request_id,
            expires_at: body.expires_at,
            grant: grant.clone(),
        });
        ledger.clock = now;
        ledger.save(records)?;
        Ok(grant)
    }
}

#[cfg(test)]
mod tests;
