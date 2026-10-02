//! Anonymous password recovery: no operation nonce or received code crosses FFI.
use crate::{Client, accounts, model::RvError, on_tokio};
use rv_core::native::{
    Error, Identity,
    email_recovery::{Form, FormView, Scope},
};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NativeRecoveryEmailState {
    pub view_revision: u64,
    pub username: String,
    pub requested: bool,
    pub accepted: bool,
    pub expired: bool,
    pub retry_after_seconds: u32,
    pub identity_changed: bool,
}
impl From<FormView> for NativeRecoveryEmailState {
    fn from(v: FormView) -> Self {
        Self {
            view_revision: v.revision,
            username: v.username,
            requested: v.requested,
            accepted: v.accepted,
            expired: v.expired,
            retry_after_seconds: v.retry_after_seconds,
            identity_changed: v.identity_changed,
        }
    }
}
#[derive(uniffi::Object)]
pub struct NativeRecoveryEmail {
    form: Arc<Form>,
}
impl Drop for NativeRecoveryEmail {
    fn drop(&mut self) {
        self.form.close();
    }
}
fn error(e: Error) -> RvError {
    rv_core::native::rest_error(e).into()
}
#[uniffi::export]
impl Client {
    /// Local vault read only, pinned to the discovery already shown by the form.
    pub async fn native_email_recovery(
        &self,
        server: String,
        user: String,
        instance_id: String,
        data_epoch: String,
    ) -> Result<Arc<NativeRecoveryEmail>, RvError> {
        let url =
            rv_core::session::normalize_server(&server).ok_or_else(|| RvError::local("invalid server address"))?;
        let scope = Scope::from_identity(url.as_str(), &user, &Identity { instance_id, data_epoch }).map_err(error)?;
        let dirs = self.dirs.clone();
        let form = on_tokio(async move { Form::open(accounts::email_recovery_vault(&dirs), scope).await })
            .await
            .map_err(error)?;
        Ok(Arc::new(NativeRecoveryEmail { form: Arc::new(form) }))
    }
}
#[uniffi::export]
impl NativeRecoveryEmail {
    pub fn close(&self) {
        self.form.close();
    }
    pub fn snapshot(&self) -> Option<NativeRecoveryEmailState> {
        self.form.view().map(Into::into)
    }
    pub async fn submit(&self, view_revision: u64) -> Result<(), RvError> {
        let form = self.form.clone();
        on_tokio(async move { form.submit(view_revision).await }).await.map_err(error)
    }
    pub async fn forget(&self, view_revision: u64) -> Result<(), RvError> {
        let form = self.form.clone();
        on_tokio(async move { form.forget(view_revision).await }).await.map_err(error)
    }
}
