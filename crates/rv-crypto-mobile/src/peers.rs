//! Opaque native peer view/consent. No private pin record crosses Expo.
use super::*;
use rv_crypto::account::{self, Directory, peers};
use rv_protocol::e2ee;

#[derive(Clone)]
#[cfg_attr(feature = "native-bindings", derive(uniffi::Record))]
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerReview {
    pub id: String,
    pub status_json: String,
}
#[derive(Clone)]
#[cfg_attr(feature = "native-bindings", derive(uniffi::Record))]
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerApproval {
    pub id: String,
    pub user: String,
    pub root_fingerprint: String,
    pub device: String,
    pub fingerprint: String,
    pub incarnation: String,
    pub expires_at: String,
}
fn id() -> std::result::Result<String, account::Error> {
    let mut nonce = [0; 16];
    getrandom::fill(&mut nonce).map_err(|_| account::Error::Changed)?;
    Ok(data_encoding::HEXLOWER.encode(&nonce))
}
impl CryptoInstallation {
    fn peer_directory(
        &self,
        user: &str,
        wire: &str,
    ) -> std::result::Result<Directory, account::Error> {
        if wire.len() > 8 * 1024 * 1024 {
            return Err(account::Error::Changed);
        }
        let wire: e2ee::Directory =
            serde_json::from_str(wire).map_err(|_| account::Error::Changed)?;
        Directory::verify(&self.slot, user, wire)
    }
    fn peer_saved(&self, view: peers::View) -> std::result::Result<PeerReview, account::Error> {
        let id = id()?;
        let status_json =
            serde_json::to_string(&view.status).map_err(|_| account::Error::Changed)?;
        *self
            .peer_review
            .lock()
            .map_err(|_| account::Error::Changed)? = Some((id.clone(), view));
        Ok(PeerReview { id, status_json })
    }
    fn peer_selected(&self, id: &str) -> std::result::Result<peers::View, account::Error> {
        let (expected, view) = self
            .peer_review
            .lock()
            .map_err(|_| account::Error::Changed)?
            .take()
            .ok_or(account::Error::Changed)?;
        if expected != id {
            return Err(account::Error::Changed);
        }
        Ok(view)
    }
}
#[cfg_attr(feature = "native-bindings", uniffi::export)]
impl CryptoInstallation {
    pub fn peer_view(
        &self,
        own_directory: String,
        user: String,
        peer_directory: String,
    ) -> Result<PeerReview> {
        self.identity_call(&own_directory, |_, own, time| {
            *self
                .peer_approval
                .lock()
                .map_err(|_| account::Error::Changed)? = None;
            let coordinator = peers::Coordinator::new(&self.slot, own, time)?;
            let directory = self.peer_directory(&user, &peer_directory)?;
            self.peer_saved(coordinator.read(directory, time)?)
        })
    }
    pub fn peer_pin(
        &self,
        own_directory: String,
        peer_directory: String,
        view_id: String,
        choice: String,
        confirmed: String,
        old: String,
    ) -> Result<PeerReview> {
        self.identity_call(&own_directory, |_, own, time| {
            let view = self.peer_selected(&view_id)?;
            let directory = self.peer_directory(&view.status.user, &peer_directory)?;
            let choice = match choice.as_str() {
                "first_contact" => peers::RootChoice::FirstContact,
                "verify" => peers::RootChoice::Verify,
                "replace" => peers::RootChoice::Replace,
                _ => return Err(account::Error::Changed),
            };
            let coordinator = peers::Coordinator::new(&self.slot, own, time)?;
            self.peer_saved(coordinator.pin(view, directory, choice, &confirmed, &old, time)?)
        })
    }
    pub fn peer_preview(
        &self,
        own_directory: String,
        peer_directory: String,
        view_id: String,
        device: String,
    ) -> Result<PeerApproval> {
        self.identity_call(&own_directory, |_, own, time| {
            let view = self.peer_selected(&view_id)?;
            let directory = self.peer_directory(&view.status.user, &peer_directory)?;
            let coordinator = peers::Coordinator::new(&self.slot, own, time)?;
            let approval = coordinator.preview(view, directory, &device, time)?;
            let id = id()?;
            let public = PeerApproval {
                id: id.clone(),
                user: approval.user.clone(),
                root_fingerprint: approval.root_fingerprint.clone(),
                device: approval.device.clone(),
                fingerprint: approval.fingerprint.clone(),
                incarnation: approval.incarnation.clone(),
                expires_at: approval.expires_at.clone(),
            };
            *self
                .peer_approval
                .lock()
                .map_err(|_| account::Error::Changed)? = Some((id, approval));
            Ok(public)
        })
    }
    pub fn peer_approve(
        &self,
        own_directory: String,
        peer_directory: String,
        approval_id: String,
    ) -> Result<PeerReview> {
        self.identity_call(&own_directory, |_, own, time| {
            let (expected, approval) = self
                .peer_approval
                .lock()
                .map_err(|_| account::Error::Changed)?
                .take()
                .ok_or(account::Error::Changed)?;
            if expected != approval_id {
                return Err(account::Error::Changed);
            }
            let directory = self.peer_directory(&approval.user, &peer_directory)?;
            let coordinator = peers::Coordinator::new(&self.slot, own, time)?;
            self.peer_saved(coordinator.approve(approval, directory, time)?)
        })
    }
}
