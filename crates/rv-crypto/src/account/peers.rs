//! Protected peer review for native adapters. Reading never accepts a new root;
//! only authenticated withdrawals from an existing pin are learned implicitly.
use super::*;
use crate::identity::{Consent, Observation, Pins};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Trust {
    Unknown,
    Unverified,
    Verified,
    Changed,
}
impl From<Observation> for Trust {
    fn from(value: Observation) -> Self {
        match value {
            Observation::Unknown => Self::Unknown,
            Observation::Unverified => Self::Unverified,
            Observation::Verified => Self::Verified,
            Observation::Changed => Self::Changed,
        }
    }
}
#[derive(Serialize)]
pub struct Device {
    pub id: String,
    pub incarnation: String,
    pub fingerprint: String,
    pub expires_at: String,
    pub approved: bool,
}
#[derive(Serialize)]
pub struct Status {
    pub user: String,
    pub fingerprint: String,
    pub previous_fingerprint: String,
    pub trust: Trust,
    pub devices: Vec<Device>,
}
pub struct View {
    pub status: Status,
    directory: Directory,
}
pub enum RootChoice {
    FirstContact,
    Verify,
    Replace,
}
pub struct Approval {
    pub user: String,
    pub root_fingerprint: String,
    pub device: String,
    pub fingerprint: String,
    pub incarnation: String,
    pub expires_at: String,
    directory: Directory,
    certificate: Certificate,
    consent: Consent,
}
pub struct Coordinator {
    manager: Arc<Manager>,
    account: crate::installation::Account,
}
fn fingerprint(value: &str) -> Result<[u8; 32]> {
    let fp: [u8; 32] = HEXLOWER
        .decode(value.as_bytes())
        .map_err(|_| Error::Changed)?
        .try_into()
        .map_err(|_| Error::Changed)?;
    if hex(&fp) != value {
        return Err(Error::Changed);
    }
    Ok(fp)
}
impl Directory {
    fn peer_root(&self) -> Result<Root> {
        let identity = self.wire.identity.as_ref().ok_or(Error::Changed)?;
        serde_json::from_slice(&decode(&identity.root, 4096)?).map_err(|_| Error::Changed)
    }
    fn same_peer(&self, other: &Self) -> Result<bool> {
        Ok(self.account == other.account
            && self.user == other.user
            && serde_json::to_vec(&self.wire).map_err(|_| Error::Changed)?
                == serde_json::to_vec(&other.wire).map_err(|_| Error::Changed)?)
    }
    fn apply_peer(
        &self,
        pins: &mut Pins,
        records: &Records,
        manager: &Manager,
    ) -> std::result::Result<(), vault::Error> {
        let root = self.peer_root().map_err(|_| vault::Error::Rejected)?;
        super::revocations::apply_known(records, manager, &root, pins)?;
        if pins.pinned_root(&root.user) == Some(&root) {
            for item in &self.wire.revocations {
                let signed: Revocation = serde_json::from_slice(
                    &decode(&item.signed, 4096).map_err(|_| vault::Error::Rejected)?,
                )
                .map_err(|_| vault::Error::Rejected)?;
                private(pins.apply_revocation(&signed))?;
            }
        }
        Ok(())
    }
}
impl Coordinator {
    pub fn new(slot: &Installation, own_directory: &Directory, time: u64) -> Result<Self> {
        let (manager, _) = super::Coordinator::new(slot).prepared(own_directory, time)?;
        Ok(Self {
            manager,
            account: slot.account().clone(),
        })
    }
    fn bind(&self, directory: &Directory) -> Result<()> {
        if directory.account != self.account {
            return Err(Error::Changed);
        }
        Ok(())
    }
    fn pins<T>(
        &self,
        action: impl FnOnce(&Pins) -> std::result::Result<T, vault::Error>,
    ) -> Result<T> {
        Ok(self
            .manager
            .inspect(|_, records| action(&private(Pins::load(records, &self.account.instance))?))?)
    }
    pub fn read(&self, directory: Directory, time: u64) -> Result<View> {
        self.bind(&directory)?;
        if directory.wire.identity.is_none() {
            return Ok(View {
                status: Status {
                    user: directory.user.clone(),
                    fingerprint: String::new(),
                    previous_fingerprint: self.pins(|pins| {
                        pins.pinned_root(&directory.user)
                            .map(|r| private(r.fingerprint()).map(|f| hex(&f)))
                            .transpose()
                            .map(|v| v.unwrap_or_default())
                    })?,
                    trust: Trust::Unknown,
                    devices: vec![],
                },
                directory,
            });
        }
        let root = directory.peer_root()?;
        let changed = self.manager.inspect(|_, records| {
            let mut next = private(Pins::load(records, &self.account.instance))?;
            let before = serde_json::to_vec(&next).map_err(|_| vault::Error::Integrity)?;
            directory.apply_peer(&mut next, records, &self.manager)?;
            Ok(before != serde_json::to_vec(&next).map_err(|_| vault::Error::Integrity)?)
        })?;
        if changed {
            self.manager.transact(|_, records| {
                let mut pins = private(Pins::load(records, &self.account.instance))?;
                directory.apply_peer(&mut pins, records, &self.manager)?;
                private(pins.save(records))
            })?;
        }
        let status = self.pins(|pins| {
            let devices = directory
                .wire
                .devices
                .iter()
                .map(|d| {
                    let certificate: Certificate = serde_json::from_slice(
                        &decode(&d.certificate, 4096).map_err(|_| vault::Error::Rejected)?,
                    )
                    .map_err(|_| vault::Error::Rejected)?;
                    Ok(Device {
                        id: d.device_id.clone(),
                        incarnation: d.incarnation.clone(),
                        fingerprint: hex(&private(certificate.fingerprint())?),
                        expires_at: certificate.device.expires_at.to_string(),
                        approved: pins
                            .authorize_credential(
                                &private(certificate.credential())?,
                                &certificate.device.signature_key,
                                time,
                            )
                            .is_ok(),
                    })
                })
                .collect::<std::result::Result<Vec<_>, vault::Error>>()?;
            Ok(Status {
                user: root.user.clone(),
                fingerprint: hex(&private(root.fingerprint())?),
                previous_fingerprint: pins
                    .pinned_root(&root.user)
                    .map(|r| private(r.fingerprint()).map(|f| hex(&f)))
                    .transpose()?
                    .unwrap_or_default(),
                trust: private(pins.observe(&root))?.into(),
                devices,
            })
        })?;
        Ok(View { status, directory })
    }
    pub fn pin(
        &self,
        previous: View,
        current: Directory,
        choice: RootChoice,
        confirmed: &str,
        old: &str,
        time: u64,
    ) -> Result<View> {
        self.bind(&current)?;
        self.read(current.clone(), time)?;
        if !previous.directory.same_peer(&current)? {
            return Err(Error::Changed);
        }
        let root = current.peer_root()?;
        let confirmed = fingerprint(confirmed)?;
        let old = if matches!(choice, RootChoice::Replace) {
            Some(fingerprint(old)?)
        } else {
            None
        };
        self.manager.transact(|_, records| {
            let mut pins = private(Pins::load(records, &self.account.instance))?;
            match choice {
                RootChoice::FirstContact => private(pins.accept_first(root, confirmed))?,
                RootChoice::Verify => private(pins.verify_root(&root, confirmed))?,
                RootChoice::Replace => private(pins.replace_verified(
                    old.ok_or(vault::Error::Rejected)?,
                    root,
                    confirmed,
                ))?,
            }
            current.apply_peer(&mut pins, records, &self.manager)?;
            private(pins.save(records))
        })?;
        self.read(current, time)
    }
    pub fn preview(
        &self,
        previous: View,
        current: Directory,
        device: &str,
        time: u64,
    ) -> Result<Approval> {
        self.bind(&current)?;
        self.read(current.clone(), time)?;
        if !previous.directory.same_peer(&current)? {
            return Err(Error::Changed);
        }
        let device = current
            .wire
            .devices
            .iter()
            .find(|d| d.device_id == device)
            .ok_or(Error::Changed)?;
        let certificate: Certificate = serde_json::from_slice(&decode(&device.certificate, 4096)?)
            .map_err(|_| Error::Changed)?;
        let consent = self.pins(|pins| private(pins.preview_device(&certificate, time)))?;
        Ok(Approval {
            user: current.user.clone(),
            root_fingerprint: hex(&certificate.device.root.fingerprint()?),
            device: certificate.device.device.clone(),
            fingerprint: hex(&certificate.fingerprint()?),
            incarnation: hex(&certificate.device.incarnation),
            expires_at: certificate.device.expires_at.to_string(),
            directory: current,
            certificate,
            consent,
        })
    }
    pub fn approve(&self, approval: Approval, current: Directory, time: u64) -> Result<View> {
        self.bind(&current)?;
        self.read(current.clone(), time)?;
        if !approval.directory.same_peer(&current)? {
            return Err(Error::Changed);
        }
        self.manager.transact(|_, records| {
            let mut pins = private(Pins::load(records, &self.account.instance))?;
            current.apply_peer(&mut pins, records, &self.manager)?;
            private(pins.approve(&approval.certificate, &approval.consent, time))?;
            private(pins.save(records))
        })?;
        self.read(current, time)
    }
}
