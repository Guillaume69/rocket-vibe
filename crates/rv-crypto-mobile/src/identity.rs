//! Only signed public ceremony material crosses the bridge. The controller,
//! device seed, original request and consent stay in the protected Rust state.
use super::*;
use rv_crypto::account::{self, Coordinator};
use rv_protocol::e2ee;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum IdentityPhase {
    Missing,
    IdentityCreated,
    WaitingForApproval,
    Registering,
    Ready,
    Expired,
    Renewing,
}
#[derive(Clone, uniffi::Record)]
pub struct IdentityStatus {
    pub phase: IdentityPhase,
    pub root_fingerprint: String,
    pub remote_fingerprint: String,
    pub request_fingerprint: String,
    pub request_code: String,
    pub controls_root: bool,
    pub certificate_expires_at: Option<String>,
}
impl From<account::View> for IdentityStatus {
    fn from(value: account::View) -> Self {
        Self {
            phase: match value.stage {
                account::Stage::Missing => IdentityPhase::Missing,
                account::Stage::IdentityCreated => IdentityPhase::IdentityCreated,
                account::Stage::WaitingForApproval => IdentityPhase::WaitingForApproval,
                account::Stage::Registering => IdentityPhase::Registering,
                account::Stage::Ready => IdentityPhase::Ready,
                account::Stage::Expired => IdentityPhase::Expired,
                account::Stage::Renewing => IdentityPhase::Renewing,
            },
            root_fingerprint: value.root_fingerprint,
            remote_fingerprint: value.remote_fingerprint,
            request_fingerprint: value.request_fingerprint,
            request_code: value.request_code,
            controls_root: value.controls_root,
            certificate_expires_at: value.certificate_expires_at.map(|time| time.to_string()),
        }
    }
}
#[derive(Clone, uniffi::Record)]
pub struct IdentityApproval {
    pub id: String,
    pub root_fingerprint: String,
    pub request_fingerprint: String,
    pub device: String,
    pub expires_at: String,
}
impl CryptoInstallation {
    pub(super) fn identity_call<T>(
        &self,
        directory: &str,
        action: impl FnOnce(
            &Coordinator<'_>,
            &account::Directory,
            u64,
        ) -> std::result::Result<T, account::Error>,
    ) -> Result<T> {
        let _serial = self.serial.lock().map_err(|_| CryptoBridgeError::Closed)?;
        self.check()?;
        if directory.len() > 8 * 1024 * 1024 {
            return Err(CryptoBridgeError::Integrity);
        }
        let wire: e2ee::Directory =
            serde_json::from_str(directory).map_err(|_| CryptoBridgeError::Integrity)?;
        let coordinator = Coordinator::new(&self.slot);
        let directory = coordinator
            .directory(wire)
            .map_err(|_| CryptoBridgeError::Changed)?;
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| CryptoBridgeError::Changed)?
            .as_secs();
        let result = action(&coordinator, &directory, time);
        if matches!(result, Err(account::Error::Withdrawn(_))) {
            self.stop();
        }
        self.check()?;
        result.map_err(|error| match error {
            account::Error::Storage(error) => error.into(),
            _ => CryptoBridgeError::Changed,
        })
    }
}
#[uniffi::export]
impl CryptoInstallation {
    pub fn identity_view(&self, directory: String) -> Result<IdentityStatus> {
        self.identity_call(&directory, |c, d, time| Ok(c.view(d, time)?.into()))
    }
    /// Explicit creation, or adoption after the user compares the root fingerprint.
    pub fn identity_begin(
        &self,
        directory: String,
        expected_root: String,
    ) -> Result<IdentityStatus> {
        self.identity_call(&directory, |c, d, time| {
            c.begin(d, &expected_root, time)?;
            Ok(c.view(d, time)?.into())
        })
    }
    pub fn identity_renew(
        &self,
        directory: String,
        expected_root: String,
    ) -> Result<IdentityStatus> {
        self.identity_call(&directory, |c, d, time| {
            c.renew(d, &expected_root, time)?;
            Ok(c.view(d, time)?.into())
        })
    }
    pub fn identity_preview(
        &self,
        directory: String,
        request_code: String,
    ) -> Result<IdentityApproval> {
        self.identity_call(&directory, |c, d, time| {
            let preview = c.preview(d, &request_code, time)?;
            let mut nonce = [0; 16];
            getrandom::fill(&mut nonce).map_err(|_| account::Error::Changed)?;
            let id = data_encoding::HEXLOWER.encode(&nonce);
            let public = IdentityApproval {
                id: id.clone(),
                root_fingerprint: preview.root_fingerprint.clone(),
                request_fingerprint: preview.request_fingerprint.clone(),
                device: preview.device.clone(),
                expires_at: preview.expires_at.to_string(),
            };
            *self.approval.lock().map_err(|_| account::Error::Changed)? = Some((id, preview));
            Ok(public)
        })
    }
    pub fn identity_approve(&self, directory: String, approval_id: String) -> Result<String> {
        self.identity_call(&directory, |c, d, time| {
            let (id, preview) = self
                .approval
                .lock()
                .map_err(|_| account::Error::Changed)?
                .take()
                .ok_or(account::Error::Changed)?;
            if id != approval_id {
                return Err(account::Error::Changed);
            }
            c.approve(d, preview, time)
        })
    }
    /// Persist the exact original registration before any HTTP submission.
    pub fn identity_install(
        &self,
        directory: String,
        grant_code: String,
    ) -> Result<IdentityStatus> {
        self.identity_call(&directory, |c, d, time| {
            c.install(d, &grant_code, time)?;
            Ok(c.view(d, time)?.into())
        })
    }
    pub fn identity_pending(&self, directory: String) -> Result<String> {
        self.identity_call(&directory, |c, d, time| {
            c.view(d, time)?;
            serde_json::to_string(&c.pending()?).map_err(|_| account::Error::Changed)
        })
    }
    pub fn identity_acknowledge(
        &self,
        directory: String,
        receipt: String,
    ) -> Result<IdentityStatus> {
        self.identity_call(&directory, |c, d, time| {
            if receipt.len() > 32768 {
                return Err(account::Error::Changed);
            }
            c.view(d, time)?;
            let receipt: e2ee::OperationReceipt =
                serde_json::from_str(&receipt).map_err(|_| account::Error::Changed)?;
            c.acknowledge(&c.pending()?, receipt)?;
            Ok(c.view(d, time)?.into())
        })
    }
}
