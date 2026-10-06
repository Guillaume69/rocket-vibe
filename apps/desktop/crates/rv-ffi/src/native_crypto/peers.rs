use super::*;
use enrollment::peers::{self, RootChoice};

#[derive(Clone, Copy, uniffi::Enum)]
pub enum NativePeerTrust {
    Unknown,
    Unverified,
    Verified,
    Changed,
}
#[derive(Clone, Copy, uniffi::Enum)]
pub enum NativePeerRootAction {
    FirstContact,
    Verify,
    Replace,
}
#[derive(Clone, uniffi::Record)]
pub struct NativePeerDevice {
    pub id: String,
    pub incarnation: String,
    pub fingerprint: String,
    pub expires_at: u64,
    pub approved: bool,
}
#[derive(Clone, uniffi::Record)]
pub struct NativePeerApproval {
    pub device: String,
    pub fingerprint: String,
    pub root_fingerprint: String,
    pub incarnation: String,
    pub expires_at: u64,
}
#[derive(Clone, uniffi::Record)]
pub struct NativePeerState {
    pub user: String,
    pub fingerprint: String,
    pub previous_fingerprint: String,
    pub trust: NativePeerTrust,
    pub devices: Vec<NativePeerDevice>,
    pub approval: Option<NativePeerApproval>,
    pub revision: u64,
}
fn display(value: &peers::View, revision: u64) -> NativePeerState {
    NativePeerState {
        user: value.user.clone(),
        fingerprint: value.fingerprint.clone(),
        previous_fingerprint: value.previous_fingerprint.clone(),
        trust: match value.trust {
            peers::Trust::Unknown => NativePeerTrust::Unknown,
            peers::Trust::Unverified => NativePeerTrust::Unverified,
            peers::Trust::Verified => NativePeerTrust::Verified,
            peers::Trust::Changed => NativePeerTrust::Changed,
        },
        devices: value
            .devices
            .iter()
            .map(|d| NativePeerDevice {
                id: d.id.clone(),
                incarnation: d.incarnation.clone(),
                fingerprint: d.fingerprint.clone(),
                expires_at: d.expires_at,
                approved: d.approved,
            })
            .collect(),
        approval: None,
        revision,
    }
}
struct State {
    revision: u64,
    view: Option<peers::View>,
    approval: Option<peers::Approval>,
    display: Option<NativePeerState>,
}
struct PeerInner {
    access: Access,
    user: String,
    serial: tokio::sync::Mutex<()>,
    state: Mutex<State>,
}
#[derive(uniffi::Object)]
pub struct NativeCryptoPeer {
    inner: Arc<PeerInner>,
}
impl NativeCryptoPeer {
    pub(crate) async fn open(
        session: Arc<NativeSession>,
        dirs: Arc<accounts::Dirs>,
        user: String,
    ) -> Result<Arc<Self>, Error> {
        let access = session
            .crypto_settings(
                Guard::new(),
                dirs.data.join("native-crypto"),
                Arc::new(rv_crypto::protected::system::Keyring),
            )
            .await?;
        Ok(Arc::new(Self {
            inner: Arc::new(PeerInner {
                access,
                user,
                serial: tokio::sync::Mutex::new(()),
                state: Mutex::new(State { revision: 0, view: None, approval: None, display: None }),
            }),
        }))
    }
    async fn act(&self, action: Action) -> Result<NativePeerState, RvError> {
        let inner = self.inner.clone();
        on_tokio(async move {
            let _serial = inner.serial.lock().await;
            inner.access.check()?;
            let (revision, view, approval, previous) = {
                let mut state = inner.state.lock().unwrap();
                if let Some(expected) = action.revision()
                    && expected != state.revision
                {
                    return Err(rv_core::native::Error::Protocol("crypto_peer_changed").into());
                }
                state.revision += 1;
                (state.revision, state.view.take(), state.approval.take(), state.display.take())
            };
            let next = match action {
                Action::Refresh => inner.access.peer(inner.user.clone()).await?,
                Action::Root(_, action, confirmed, old) => {
                    inner
                        .access
                        .pin_peer(
                            view.ok_or(rv_core::native::Error::Protocol("crypto_peer_changed"))?,
                            match action {
                                NativePeerRootAction::FirstContact => RootChoice::FirstContact,
                                NativePeerRootAction::Verify => RootChoice::Verify,
                                NativePeerRootAction::Replace => RootChoice::Replace,
                            },
                            confirmed,
                            old,
                        )
                        .await?
                }
                Action::Approve(_) => {
                    inner
                        .access
                        .approve_peer_device(approval.ok_or(rv_core::native::Error::Protocol("crypto_peer_changed"))?)
                        .await?
                }
                Action::Preview(_, device) => {
                    let approval = inner
                        .access
                        .preview_peer_device(
                            view.ok_or(rv_core::native::Error::Protocol("crypto_peer_changed"))?,
                            device,
                        )
                        .await?;
                    inner.access.check()?;
                    let mut displayed = previous.ok_or(rv_core::native::Error::Protocol("crypto_peer_changed"))?;
                    displayed.revision = revision;
                    displayed.approval = Some(NativePeerApproval {
                        device: approval.device.clone(),
                        fingerprint: approval.fingerprint.clone(),
                        root_fingerprint: approval.root_fingerprint.clone(),
                        incarnation: approval.incarnation.clone(),
                        expires_at: approval.expires_at,
                    });
                    let mut state = inner.state.lock().unwrap();
                    inner.access.check()?;
                    state.approval = Some(approval);
                    state.display = Some(displayed.clone());
                    return Ok(displayed);
                }
            };
            inner.access.check()?;
            let displayed = display(&next, revision);
            let mut state = inner.state.lock().unwrap();
            inner.access.check()?;
            state.view = Some(next);
            state.display = Some(displayed.clone());
            Ok(displayed)
        })
        .await
        .map_err(error)
    }
}
enum Action {
    Refresh,
    Root(u64, NativePeerRootAction, String, String),
    Preview(u64, String),
    Approve(u64),
}
impl Action {
    fn revision(&self) -> Option<u64> {
        match self {
            Self::Refresh => None,
            Self::Root(v, ..) | Self::Preview(v, ..) | Self::Approve(v) => Some(*v),
        }
    }
}
#[uniffi::export]
impl NativeCryptoPeer {
    pub fn close(&self) {
        self.inner.access.close();
        let mut state = self.inner.state.lock().unwrap();
        state.revision += 1;
        state.view = None;
        state.approval = None;
        state.display = None;
    }
    pub fn is_closed(&self) -> bool {
        self.inner.access.check().is_err()
    }
    pub async fn refresh(&self) -> Result<NativePeerState, RvError> {
        self.act(Action::Refresh).await
    }
    pub async fn pin_root(
        &self,
        revision: u64,
        action: NativePeerRootAction,
        confirmed: String,
        previous: String,
    ) -> Result<NativePeerState, RvError> {
        self.act(Action::Root(revision, action, confirmed, previous)).await
    }
    pub async fn preview_device(&self, revision: u64, device: String) -> Result<NativePeerState, RvError> {
        self.act(Action::Preview(revision, device)).await
    }
    pub async fn approve_device(&self, revision: u64) -> Result<NativePeerState, RvError> {
        self.act(Action::Approve(revision)).await
    }
}
impl Drop for NativeCryptoPeer {
    fn drop(&mut self) {
        self.close();
    }
}
