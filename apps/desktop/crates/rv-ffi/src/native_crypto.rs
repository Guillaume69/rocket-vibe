//! One opaque settings handle. Public ceremony values and explicit temporary
//! recovery-code display/input cross UniFFI. Signing keys, protected selection
//! and approval consent stay inside Rust.
use crate::{accounts, model::RvError, on_tokio};
use rv_core::native::{
    NativeSession,
    crypto::{
        Error,
        enrollment::{self, Access, Approval, Stage},
    },
    security::Guard,
};
use std::sync::{Arc, Mutex};
pub(crate) mod messages;
pub(crate) mod peers;
pub(crate) mod quote_composer;
pub(crate) mod quote_reader;
mod recovery;
pub(crate) mod rooms;
mod withdrawals;

#[derive(Clone, Copy, uniffi::Enum)]
pub enum NativeCryptoPhase {
    Missing,
    IdentityCreated,
    WaitingForApproval,
    Registering,
    Ready,
    Expired,
    Renewing,
}
#[derive(Clone, uniffi::Record)]
pub struct NativeCryptoState {
    pub phase: NativeCryptoPhase,
    pub root_fingerprint: String,
    pub remote_fingerprint: String,
    pub request_fingerprint: String,
    pub request_code: String,
    pub controls_root: bool,
    pub certificate_expires_at: Option<u64>,
    pub view_revision: u64,
}
#[derive(Clone, uniffi::Record)]
pub struct NativeCryptoApproval {
    pub root_fingerprint: String,
    pub request_fingerprint: String,
    pub device: String,
    pub expires_at: u64,
    pub view_revision: u64,
}
struct Inner {
    access: Access,
    serial: tokio::sync::Mutex<()>,
    state: Mutex<(u64, Option<Approval>)>,
    withdrawal: Mutex<Option<(u64, enrollment::revocations::Approval)>>,
    recovery: Mutex<Option<(u64, recovery::Staged)>>,
}
#[derive(uniffi::Object)]
pub struct NativeCrypto {
    inner: Arc<Inner>,
}
pub(crate) fn error(error: Error) -> RvError {
    match error {
        Error::Session(error) => rv_core::native::rest_error(error).into(),
        _ => RvError::Local { message: "crypto_operation_failed".into() },
    }
}
fn state(view: enrollment::View, revision: u64) -> NativeCryptoState {
    NativeCryptoState {
        phase: match view.stage {
            Stage::Missing => NativeCryptoPhase::Missing,
            Stage::IdentityCreated => NativeCryptoPhase::IdentityCreated,
            Stage::WaitingForApproval => NativeCryptoPhase::WaitingForApproval,
            Stage::Registering => NativeCryptoPhase::Registering,
            Stage::Ready => NativeCryptoPhase::Ready,
            Stage::Expired => NativeCryptoPhase::Expired,
            Stage::Renewing => NativeCryptoPhase::Renewing,
        },
        root_fingerprint: view.root_fingerprint,
        remote_fingerprint: view.remote_fingerprint,
        request_fingerprint: view.request_fingerprint,
        request_code: view.request_code,
        controls_root: view.controls_root,
        certificate_expires_at: view.certificate_expires_at,
        view_revision: revision,
    }
}
impl NativeCrypto {
    pub(crate) async fn open(session: Arc<NativeSession>, dirs: Arc<accounts::Dirs>) -> Result<Arc<Self>, Error> {
        let access = session
            .crypto_settings(
                Guard::new(),
                dirs.data.join("native-crypto"),
                Arc::new(rv_crypto::protected::system::Keyring),
            )
            .await?;
        Ok(Arc::new(Self {
            inner: Arc::new(Inner {
                access,
                serial: tokio::sync::Mutex::new(()),
                state: Mutex::new((0, None)),
                withdrawal: Mutex::new(None),
                recovery: Mutex::new(None),
            }),
        }))
    }
    async fn view(&self, action: ViewAction) -> Result<NativeCryptoState, RvError> {
        let inner = self.inner.clone();
        on_tokio(async move {
            let _serial = inner.serial.lock().await;
            let revision = {
                let mut state = inner.state.lock().unwrap();
                state.0 += 1;
                state.1 = None;
                state.0
            };
            let view = match action {
                ViewAction::Refresh => inner.access.refresh().await,
                ViewAction::Begin(fingerprint) => inner.access.begin(fingerprint).await,
                ViewAction::Renew(fingerprint) => inner.access.renew(fingerprint).await,
                ViewAction::Install(code) => inner.access.install(code).await,
                ViewAction::Resume => inner.access.resume().await,
            }?;
            inner.access.check()?;
            Ok(state(view, revision))
        })
        .await
        .map_err(error)
    }
}
enum ViewAction {
    Refresh,
    Begin(String),
    Renew(String),
    Install(String),
    Resume,
}
#[uniffi::export]
impl NativeCrypto {
    pub fn close(&self) {
        self.inner.access.close();
        self.inner.state.lock().unwrap().1 = None;
        self.inner.withdrawal.lock().unwrap().take();
        self.inner.recovery.lock().unwrap().take();
    }
    pub fn is_closed(&self) -> bool {
        self.inner.access.check().is_err()
    }
    pub async fn refresh(&self) -> Result<NativeCryptoState, RvError> {
        self.view(ViewAction::Refresh).await
    }
    pub async fn begin(&self, expected_fingerprint: String) -> Result<NativeCryptoState, RvError> {
        self.view(ViewAction::Begin(expected_fingerprint)).await
    }
    pub async fn renew(&self, expected_fingerprint: String) -> Result<NativeCryptoState, RvError> {
        self.view(ViewAction::Renew(expected_fingerprint)).await
    }
    pub async fn install(&self, code: String) -> Result<NativeCryptoState, RvError> {
        self.view(ViewAction::Install(code)).await
    }
    pub async fn resume(&self) -> Result<NativeCryptoState, RvError> {
        self.view(ViewAction::Resume).await
    }
    pub async fn preview(&self, request_code: String) -> Result<NativeCryptoApproval, RvError> {
        let inner = self.inner.clone();
        on_tokio(async move {
            let _serial = inner.serial.lock().await;
            let revision = {
                let mut state = inner.state.lock().unwrap();
                state.0 += 1;
                state.1 = None;
                state.0
            };
            let preview = inner.access.preview(request_code).await?;
            inner.access.check()?;
            let display = NativeCryptoApproval {
                root_fingerprint: preview.root_fingerprint.clone(),
                request_fingerprint: preview.request_fingerprint.clone(),
                device: preview.device.clone(),
                expires_at: preview.expires_at,
                view_revision: revision,
            };
            inner.state.lock().unwrap().1 = Some(preview);
            Ok(display)
        })
        .await
        .map_err(error)
    }
    pub async fn approve(&self, view_revision: u64) -> Result<String, RvError> {
        let inner = self.inner.clone();
        on_tokio(async move {
            let _serial = inner.serial.lock().await;
            inner.access.check()?;
            let preview = {
                let mut state = inner.state.lock().unwrap();
                if state.0 != view_revision {
                    return Err(rv_core::native::Error::Protocol("crypto_enrollment_changed").into());
                }
                state.0 += 1;
                state.1.take().ok_or(rv_core::native::Error::Protocol("crypto_enrollment_changed"))?
            };
            inner.access.approve(preview).await
        })
        .await
        .map_err(error)
    }
}
impl Drop for NativeCrypto {
    fn drop(&mut self) {
        self.close();
    }
}
