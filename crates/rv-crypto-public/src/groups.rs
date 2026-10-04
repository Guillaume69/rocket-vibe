//! Signed application binding for opaque MLS transitions. MLS validity and local
//! identity consent are verified by recipients, independently of delivery ACKs.
use crate::{Certificate, Error, Fingerprint, verifying_key};
use ed25519_dalek::Signature;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const WIRE_LIMIT: usize = 256 * 1024;
pub const MAX_MEMBERS: usize = 128;
pub const MAX_DEVICES: usize = 256;
const DOMAIN: &str = "rocketvibe-group-transition-v1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub instance: String,
    pub data_epoch: String,
    pub room: String,
    pub incarnation: [u8; 16],
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Member {
    pub user: String,
    pub access_version: String,
    pub activation_version: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Participant {
    pub user: String,
    pub device: String,
    pub incarnation: [u8; 16],
    pub root: Fingerprint,
    pub certificate: Fingerprint,
    pub leaf: u32,
    /// The original admission reference stays bound after consumption/expiry.
    pub key_package: Option<Fingerprint>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Welcome {
    pub device: String,
    pub incarnation: [u8; 16],
    pub key_package: Fingerprint,
    pub digest: Fingerprint,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub version: u8,
    pub scope: Scope,
    pub operation: String,
    /// Zero starts a fresh group. A normal transition increments epoch by one.
    pub expected_revision: u64,
    pub expected_epoch: Option<u64>,
    pub epoch: u64,
    /// Fingerprint of the preceding accepted signed transition, zero at genesis.
    pub previous: Fingerprint,
    pub authority_version: String,
    pub members: Vec<Member>,
    /// Canonical leaf-index order, including holes left by MLS removals.
    pub participants: Vec<Participant>,
    /// Digest of the actual TLS GroupContext; recipients must verify it in MLS.
    pub context: Fingerprint,
    pub commit: Option<Fingerprint>,
    pub tree: Fingerprint,
    pub welcomes: Vec<Welcome>,
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
impl Scope {
    pub fn group_id(&self) -> Result<Fingerprint, Error> {
        if !identifier(&self.instance)
            || !identifier(&self.data_epoch)
            || !identifier(&self.room)
            || self.incarnation == [0; 16]
        {
            return Err(Error::Invalid);
        }
        Ok(Sha256::digest(frame("rocketvibe-group-id-v1", self)?).into())
    }
}
fn frame(domain: &str, value: &impl Serialize) -> Result<Vec<u8>, Error> {
    let payload = serde_json::to_vec(value).map_err(|_| Error::Invalid)?;
    if payload.len() > WIRE_LIMIT {
        return Err(Error::Limit);
    }
    let mut result = domain.as_bytes().to_vec();
    result.push(0);
    result.extend(payload);
    Ok(result)
}
impl Plan {
    pub fn signing_bytes(&self) -> Result<Vec<u8>, Error> {
        self.validate()?;
        frame(DOMAIN, self)
    }
    pub fn validate(&self) -> Result<(), Error> {
        self.scope.group_id()?;
        if self.version != 1
            || !identifier(&self.operation)
            || !identifier(&self.authority_version)
            || self.expected_revision >= i64::MAX as u64
            || self.epoch > i64::MAX as u64
            || self.context == [0; 32]
            || self.tree == [0; 32]
            || self.members.is_empty()
            || self.members.len() > MAX_MEMBERS
            || self.participants.is_empty()
            || self.participants.len() > MAX_DEVICES
            || self.welcomes.len() >= MAX_DEVICES
        {
            return Err(Error::Invalid);
        }
        if self.expected_revision == 0 {
            if self.expected_epoch.is_some()
                || self.previous != [0; 32]
                || self.epoch > 1
                || self.epoch == 0
                    && (self.participants.len() != 1
                        || self.commit.is_some()
                        || !self.welcomes.is_empty())
                || self.epoch == 1 && self.commit.is_none()
            {
                return Err(Error::Invalid);
            }
        } else if self.expected_epoch.and_then(|v| v.checked_add(1)) != Some(self.epoch)
            || self.previous == [0; 32]
            || self.commit.is_none()
        {
            return Err(Error::Invalid);
        }
        let mut users = BTreeSet::new();
        let mut last_user: Option<&str> = None;
        for member in &self.members {
            if !identifier(&member.user)
                || !identifier(&member.access_version)
                || !identifier(&member.activation_version)
                || last_user.is_some_and(|last| last >= member.user.as_str())
            {
                return Err(Error::Invalid);
            }
            users.insert(member.user.as_str());
            last_user = Some(&member.user);
        }
        let mut devices = BTreeSet::new();
        let mut represented = BTreeSet::new();
        let mut last_leaf = None;
        for device in &self.participants {
            if !users.contains(device.user.as_str())
                || !identifier(&device.device)
                || device.incarnation == [0; 16]
                || device.root == [0; 32]
                || device.certificate == [0; 32]
                || device.key_package == Some([0; 32])
                || device.leaf > 4095
                || last_leaf.is_some_and(|leaf| leaf >= device.leaf)
                || !devices.insert(device.device.as_str())
            {
                return Err(Error::Invalid);
            }
            last_leaf = Some(device.leaf);
            represented.insert(device.user.as_str());
        }
        if represented != users {
            return Err(Error::Invalid);
        }
        let mut welcomes = BTreeSet::new();
        let mut last_device: Option<&str> = None;
        for welcome in &self.welcomes {
            if welcome.digest == [0; 32]
                || last_device.is_some_and(|last| last >= welcome.device.as_str())
                || !welcomes.insert(welcome.device.as_str())
                || !self.participants.iter().any(|p| {
                    p.device == welcome.device
                        && p.incarnation == welcome.incarnation
                        && p.key_package == Some(welcome.key_package)
                })
            {
                return Err(Error::Invalid);
            }
            last_device = Some(&welcome.device);
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Transition {
    pub certificate: Certificate,
    pub plan: Plan,
    pub signature: Vec<u8>,
}
impl Transition {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > WIRE_LIMIT {
            return Err(Error::Limit);
        }
        serde_json::from_slice(bytes).map_err(|_| Error::Invalid)
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        let bytes = serde_json::to_vec(self).map_err(|_| Error::Invalid)?;
        if bytes.len() > WIRE_LIMIT {
            return Err(Error::Limit);
        }
        Ok(bytes)
    }
    pub fn verify(&self, now: u64) -> Result<(), Error> {
        self.certificate.verify(now)?;
        self.authenticate_plan()
    }
    /// Historical signature binding only, without current validity or trust.
    pub fn authenticate(&self) -> Result<(), Error> {
        self.certificate.authenticate()?;
        self.authenticate_plan()
    }
    fn authenticate_plan(&self) -> Result<(), Error> {
        let author = &self.certificate.device;
        if author.root.instance != self.plan.scope.instance
            || !self.plan.participants.iter().any(|p| {
                p.user == author.root.user
                    && p.device == author.device
                    && p.incarnation == author.incarnation
                    && author.root.fingerprint().ok() == Some(p.root)
                    && self.certificate.fingerprint().ok() == Some(p.certificate)
            })
        {
            return Err(Error::Scope);
        }
        verifying_key(&author.signature_key)?
            .verify_strict(
                &self.plan.signing_bytes()?,
                &Signature::from_slice(&self.signature).map_err(|_| Error::Signature)?,
            )
            .map_err(|_| Error::Signature)
    }
    pub fn fingerprint(&self) -> Result<Fingerprint, Error> {
        Ok(Sha256::digest(frame("rocketvibe-group-transition-fingerprint-v1", self)?).into())
    }
}
