//! Public fingerprint review in the existing profile lifecycle. A directory
//! lookup never grants peer trust, device approval or MLS admission.
use super::*;
use rv_crypto::identity::{Certificate, Consent, Observation, Pins, Revocation};
use std::collections::BTreeSet;

fn stale() -> Error {
    crate::native::Error::Protocol("crypto_peer_changed").into()
}
fn fingerprint(value: &str) -> Result<[u8; 32]> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(stale());
    }
    let mut result = [0; 32];
    for (i, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[2 * i..2 * i + 2], 16).map_err(|_| stale())?;
    }
    Ok(result)
}
#[derive(Clone, Copy, PartialEq, Eq)]
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
pub enum RootChoice {
    FirstContact,
    Verify,
    Replace,
}
#[derive(Clone)]
pub struct Device {
    pub id: String,
    pub incarnation: String,
    pub fingerprint: String,
    pub expires_at: u64,
    pub approved: bool,
}
pub struct View {
    pub user: String,
    pub fingerprint: String,
    pub previous_fingerprint: String,
    pub trust: Trust,
    pub devices: Vec<Device>,
    context: Arc<Context>,
    directory: Directory,
}
pub struct Approval {
    pub user: String,
    pub root_fingerprint: String,
    pub device: String,
    pub fingerprint: String,
    pub incarnation: String,
    pub expires_at: u64,
    context: Arc<Context>,
    directory: Directory,
    certificate: Certificate,
    consent: Consent,
}
#[derive(Clone)]
pub(super) struct Directory {
    root: Root,
    certificates: Vec<Certificate>,
    revocations: Vec<Revocation>,
}
impl Directory {
    fn same(&self, other: &Self) -> Result<bool> {
        Ok(serde_json::to_vec(&(&self.root, &self.certificates, &self.revocations)).map_err(|_| stale())?
            == serde_json::to_vec(&(&other.root, &other.certificates, &other.revocations)).map_err(|_| stale())?)
    }
    fn apply(&self, pins: &mut Pins) -> std::result::Result<(), vault::Error> {
        if pins.pinned_root(&self.root.user) == Some(&self.root) {
            for revocation in &self.revocations {
                private(pins.apply_revocation(revocation))?;
            }
        }
        Ok(())
    }
    fn display(&self, context: Arc<Context>, pins: &Pins, time: u64) -> Result<View> {
        let previous_fingerprint = pins
            .pinned_root(&self.root.user)
            .map(|r| r.fingerprint().map(|f| hex(&f)))
            .transpose()?
            .unwrap_or_default();
        let devices = self
            .certificates
            .iter()
            .map(|c| -> Result<Device> {
                Ok(Device {
                    id: c.device.device.clone(),
                    incarnation: hex(&c.device.incarnation),
                    fingerprint: hex(&c.fingerprint()?),
                    expires_at: c.device.expires_at,
                    approved: pins.authorize_credential(&c.credential()?, &c.device.signature_key, time).is_ok(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(View {
            user: self.root.user.clone(),
            fingerprint: hex(&self.root.fingerprint()?),
            previous_fingerprint,
            trust: pins.observe(&self.root)?.into(),
            devices,
            context,
            directory: self.clone(),
        })
    }
}
impl Access {
    pub(super) async fn verified_directory(
        &self,
        user: &str,
        mut page: http::Directory,
    ) -> Result<(http::Directory, Directory)> {
        if user.is_empty() || user.len() > 256 {
            return Err(stale());
        }
        self.check()?;
        let session = self.0.context.session.upgrade().ok_or_else(stale)?;
        let mut after: Option<String> = None;
        let mut root: Option<Root> = None;
        let mut certificates = Vec::new();
        let mut revocations = Vec::new();
        let mut device_wire = String::new();
        let mut position = 0u64;
        let mut complete = page.clone();
        complete.revocations.clear();
        complete.next_revocation = None;
        loop {
            self.check()?;
            if page.scope.instance_id != self.0.account.instance
                || page.scope.data_epoch != self.0.account.data_epoch
                || page.devices.len() > 64
                || page.revocations.len() > 100
                || revocations.len() + page.revocations.len() > 4096
            {
                return Err(stale());
            }
            let identity = page.identity.as_ref().ok_or_else(stale)?;
            let current: Root = serde_json::from_slice(&decode(&identity.root, 4096)?).map_err(|_| stale())?;
            current.validate()?;
            if current.instance != self.0.account.instance
                || current.user != user
                || identity.user_id != user
                || identity.fingerprint != hex(&current.fingerprint()?)
            {
                return Err(stale());
            }
            let wire = serde_json::to_string(&page.devices).map_err(|_| stale())?;
            if let Some(previous) = &root {
                if previous != &current || device_wire != wire {
                    return Err(stale());
                }
            } else {
                let mut seen = BTreeSet::new();
                for device in &page.devices {
                    let certificate: Certificate =
                        serde_json::from_slice(&decode(&device.certificate, 4096)?).map_err(|_| stale())?;
                    certificate.authenticate()?;
                    if certificate.device.root != current
                        || certificate.device.device != device.device_id
                        || hex(&certificate.device.incarnation) != device.incarnation
                        || !seen.insert(device.device_id.clone())
                    {
                        return Err(stale());
                    }
                    certificates.push(certificate);
                }
                device_wire = wire;
                root = Some(current.clone());
            }
            for item in &page.revocations {
                let incoming = item.position.parse::<u64>().map_err(|_| stale())?;
                if item.position != incoming.to_string() || incoming <= position {
                    return Err(stale());
                }
                let revocation: Revocation =
                    serde_json::from_slice(&decode(&item.signed, 4096)?).map_err(|_| stale())?;
                revocation.verify()?;
                if revocation.root != current {
                    return Err(stale());
                }
                revocations.push(revocation);
                position = incoming;
            }
            complete.revocations.extend(page.revocations);
            match page.next_revocation {
                None => break,
                Some(next) if position > 0 && next == position.to_string() && after.as_ref() != Some(&next) => {
                    after = Some(next)
                }
                _ => return Err(stale()),
            }
            page = session.client.crypto_directory(user, after.as_deref()).await.map_err(crate::native::Error::from)?;
        }
        Ok((complete, Directory { root: root.ok_or_else(stale)?, certificates, revocations }))
    }
    async fn peer_directory(&self, user: &str) -> Result<Directory> {
        self.check()?;
        let session = self.0.context.session.upgrade().ok_or_else(stale)?;
        let page = session.client.crypto_directory(user, None).await.map_err(crate::native::Error::from)?;
        self.verified_directory(user, page).await.map(|(_, directory)| directory)
    }
    async fn peer_display(&self, manager: Arc<Manager>, directory: Directory) -> Result<View> {
        let context = self.0.context.clone();
        self.owned(move |_, time| {
            // Signed withdrawals from an already trusted root are authoritative;
            // they never create a first pin or replace a changed root.
            let changed = manager.inspect(|_, records| {
                let mut pins = private(Pins::load(records, &manager.scope().instance))?;
                if directory.revocations.is_empty() || pins.pinned_root(&directory.root.user) != Some(&directory.root) {
                    return Ok(false);
                }
                let before = serde_json::to_vec(&pins).map_err(|_| vault::Error::Integrity)?;
                directory.apply(&mut pins)?;
                Ok(before != serde_json::to_vec(&pins).map_err(|_| vault::Error::Integrity)?)
            })?;
            if changed {
                manager.transact(|_, records| {
                    let mut pins = private(Pins::load(records, &manager.scope().instance))?;
                    directory.apply(&mut pins)?;
                    private(pins.save(records))
                })?;
            }
            manager
                .inspect(|_, records| {
                    let pins = private(Pins::load(records, &manager.scope().instance))?;
                    directory.display(context, &pins, time).map_err(|_| vault::Error::Rejected)
                })
                .map_err(Error::from)
        })
        .await
    }
    pub async fn peer(&self, user: String) -> Result<View> {
        let _dispatch = self.0.dispatch.lock().await;
        let (manager, _) = self.prepared().await?;
        let directory = self.peer_directory(&user).await?;
        self.peer_display(manager, directory).await
    }
    pub async fn pin_peer(&self, view: View, choice: RootChoice, confirmed: String, previous: String) -> Result<View> {
        let _dispatch = self.0.dispatch.lock().await;
        if !Arc::ptr_eq(&view.context, &self.0.context) {
            return Err(stale());
        }
        let confirmed = fingerprint(&confirmed)?;
        let old = if matches!(choice, RootChoice::Replace) { Some(fingerprint(&previous)?) } else { None };
        let (manager, _) = self.prepared().await?;
        let current = self.peer_directory(&view.directory.root.user).await?;
        if !view.directory.same(&current)? {
            return Err(stale());
        }
        let root = current.root.clone();
        let directory = current.clone();
        let selected = manager.clone();
        self.owned(move |_, _| {
            selected.transact(|_, records| {
                let mut pins = private(Pins::load(records, &selected.scope().instance))?;
                match choice {
                    RootChoice::FirstContact => private(pins.accept_first(root, confirmed))?,
                    RootChoice::Verify => private(pins.verify_root(&root, confirmed))?,
                    RootChoice::Replace => {
                        private(pins.replace_verified(old.ok_or(vault::Error::Rejected)?, root, confirmed))?
                    }
                }
                directory.apply(&mut pins)?;
                private(pins.save(records))
            })?;
            Ok(())
        })
        .await?;
        self.peer_display(manager, current).await
    }
    pub async fn preview_peer_device(&self, view: View, device: String) -> Result<Approval> {
        let _dispatch = self.0.dispatch.lock().await;
        if !Arc::ptr_eq(&view.context, &self.0.context) {
            return Err(stale());
        }
        let (manager, _) = self.prepared().await?;
        let current = self.peer_directory(&view.directory.root.user).await?;
        if !view.directory.same(&current)? {
            return Err(stale());
        }
        let certificate = current.certificates.iter().find(|c| c.device.device == device).cloned().ok_or_else(stale)?;
        let context = self.0.context.clone();
        self.owned(move |_, time| {
            let consent = manager.inspect(|_, records| {
                let pins = private(Pins::load(records, &manager.scope().instance))?;
                private(pins.preview_device(&certificate, time))
            })?;
            Ok(Approval {
                user: current.root.user.clone(),
                root_fingerprint: hex(&current.root.fingerprint()?),
                device: certificate.device.device.clone(),
                fingerprint: hex(&certificate.fingerprint()?),
                incarnation: hex(&certificate.device.incarnation),
                expires_at: certificate.device.expires_at,
                context,
                directory: current,
                certificate,
                consent,
            })
        })
        .await
    }
    pub async fn approve_peer_device(&self, approval: Approval) -> Result<View> {
        let _dispatch = self.0.dispatch.lock().await;
        if !Arc::ptr_eq(&approval.context, &self.0.context) {
            return Err(stale());
        }
        let (manager, _) = self.prepared().await?;
        let current = self.peer_directory(&approval.directory.root.user).await?;
        if !approval.directory.same(&current)? {
            return Err(stale());
        }
        let selected = manager.clone();
        let directory = current.clone();
        self.owned(move |_, time| {
            selected.transact(|_, records| {
                let mut pins = private(Pins::load(records, &selected.scope().instance))?;
                directory.apply(&mut pins)?;
                private(pins.approve(&approval.certificate, &approval.consent, time))?;
                private(pins.save(records))
            })?;
            Ok(())
        })
        .await?;
        self.peer_display(manager, current).await
    }
}
