//! A renewal keeps the exact accepted baseline until its original registration
//! has a validated acknowledgement. No root, signing key or vault is replaced.
use super::*;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Renewal {
    pub receipt: http::OperationReceipt,
    pub certificate: Certificate,
}
impl Renewal {
    pub(super) fn bound(&self, manager: &Manager, root: &Root) -> bool {
        self.certificate.authenticate().is_ok()
            && &self.certificate.device.root == root
            && self.certificate.device.device == manager.scope().device
            && hex(&self.certificate.device.incarnation) == manager.scope().incarnation
            && self.receipt.scope.instance_id == manager.scope().instance
            && self.receipt.scope.data_epoch == manager.scope().data_epoch
            && self.receipt.kind == "register_device"
            && self.receipt.device_id == manager.scope().device
            && self.receipt.incarnation == manager.scope().incarnation
            && self.receipt.root_fingerprint
                == root.fingerprint().map(|f| hex(&f)).unwrap_or_default()
            && self.receipt.device_revision.parse::<u64>().is_ok_and(|r| {
                r > 0 && r <= i64::MAX as u64 && r.to_string() == self.receipt.device_revision
            })
            && self.receipt.key_package_refs.is_empty()
    }
}
impl Coordinator<'_> {
    /// Explicit renewal of this registered incarnation, including after expiry.
    /// Only an authenticated historical certificate can enter this ceremony;
    /// expiry still prevents prepared() and every new MLS send.
    pub fn renew(&self, directory: &Directory, expected_root: &str, time: u64) -> Result<()> {
        self.bind(directory)?;
        let (manager, state) = self.state()?;
        let certificate = self.registered_certificate(&manager, &state, directory)?;
        if state.registration.is_some()
            || expected_root != hex(&state.root.fingerprint()?)
            || time <= certificate.device.issued_at
        {
            return Err(Error::Changed);
        }
        let baseline = serde_json::to_vec(state.receipt.as_ref().ok_or(Error::Changed)?)
            .map_err(|_| Error::Changed)?;
        manager.transact(|_, records| {
            let mut current = read(records, &manager)?.ok_or(vault::Error::NotInitialized)?;
            let receipt = current.receipt.as_ref().ok_or(vault::Error::Rejected)?;
            if current.registration.is_some()
                || current.withdrawn
                || revocations::pending(records, &manager, &current.root)?
                || recovery::pending(records, &manager, &current.root)?
                || serde_json::to_vec(receipt).ok().as_ref() != Some(&baseline)
            {
                return Err(vault::Error::Stale);
            }
            let mut local = private(LocalDevice::load(
                &current.root,
                &manager.scope().device,
                records,
            ))?;
            current.request = Some(private(local.request(time, records))?);
            if current.renewal.is_none() {
                current.renewal = Some(Renewal {
                    receipt: receipt.clone(),
                    certificate,
                });
            }
            save(records, &current)
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
