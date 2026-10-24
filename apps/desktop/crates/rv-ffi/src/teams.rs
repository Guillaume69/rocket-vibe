//! Signing in to Teams with a Microsoft device code: the code and its page to
//! show, then the account saved and opened once the user approves it there.
use crate::{Chat, Client, accounts, blocking, model::RvError, on_tokio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[derive(uniffi::Object)]
pub struct TeamsSignIn {
    code: Arc<rv_core::teams::auth::DeviceCode>,
    stop: Arc<AtomicBool>,
}

#[uniffi::export]
impl TeamsSignIn {
    /// What the user types at `verification_uri`.
    pub fn user_code(&self) -> String {
        self.code.user_code.clone()
    }

    pub fn verification_uri(&self) -> String {
        self.code.verification_uri.clone()
    }

    pub fn cancel(&self) {
        self.stop.store(true, Ordering::Release);
    }
}

#[uniffi::export]
impl Client {
    /// A fresh device code to show.
    pub async fn teams_sign_in(&self) -> Result<Arc<TeamsSignIn>, RvError> {
        let code = on_tokio(rv_core::teams::auth::device_code()).await?;
        Ok(Arc::new(TeamsSignIn { code: Arc::new(code), stop: Arc::default() }))
    }

    /// Waits for the code's approval, then saves and opens the account.
    pub async fn teams_approved(&self, sign_in: Arc<TeamsSignIn>) -> Result<Arc<Chat>, RvError> {
        let (code, stop) = (sign_in.code.clone(), sign_in.stop.clone());
        let info =
            on_tokio(async move { rv_core::teams::approved(&code, || stop.load(Ordering::Acquire)).await }).await?;
        let (dirs, saved) = (self.dirs.clone(), info.clone());
        blocking(move || accounts::save(&dirs, &saved, None)).await.map_err(RvError::local)?;
        self.start(info)
    }
}

/// Saves a Teams account's rotated refresh token; set once, when the client starts.
pub(crate) fn keep_rotated_tokens(dirs: Arc<accounts::Dirs>) {
    rv_core::teams::set_credential_sink(move |info| {
        let (dirs, info) = (dirs.clone(), info.clone());
        std::thread::spawn(move || {
            if let Err(e) = accounts::save(&dirs, &info, None) {
                eprintln!("Teams: rotated token not saved: {e}");
            }
        });
    });
}
