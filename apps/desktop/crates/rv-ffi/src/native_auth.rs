//! Opaque pre-authentication proof. Swift never receives its bearer or candidate.
use crate::{Client, accounts, blocking, model::RvError, native::NativeChat, on_tokio};
use rv_core::native::{
    Error,
    authentication::{self, SecondFactor},
    authentication_vault::Prepared,
};
use std::sync::{Arc, Mutex};

#[derive(uniffi::Object)]
pub struct NativeLoginAttempt {
    dirs: Arc<accounts::Dirs>,
    state: Mutex<Prepared>,
    operation: tokio::sync::Mutex<()>,
    committed: Mutex<Option<Arc<NativeChat>>>,
}
fn error(error: Error) -> RvError {
    rv_core::native::rest_error(error).into()
}

#[uniffi::export]
impl Client {
    pub async fn native_start_login(
        &self,
        server: String,
        user: String,
        password: String,
        account_code: Option<String>,
        recovering: bool,
    ) -> Result<Arc<NativeLoginAttempt>, RvError> {
        let url =
            rv_core::session::normalize_server(&server).ok_or_else(|| RvError::local("invalid server address"))?;
        if recovering && account_code.is_none() {
            return Err(error(Error::Protocol("invalid_request")));
        }
        let dirs = self.dirs.clone();
        let state = on_tokio(async move {
            let discovery = rv_core::native::probe(&url).await?.ok_or(Error::Protocol("not_native"))?;
            let step = if let Some(code) = account_code {
                authentication::start_account_code(&url, &discovery, &user, &password, &code, recovering).await?
            } else {
                authentication::start(&url, &discovery, &user, &password).await?
            };
            accounts::authentication_vault(&dirs).prepare(step).await
        })
        .await
        .map_err(error)?;
        Ok(Arc::new(NativeLoginAttempt {
            dirs: self.dirs.clone(),
            state: Mutex::new(state),
            operation: tokio::sync::Mutex::new(()),
            committed: Mutex::default(),
        }))
    }
}

#[uniffi::export]
impl NativeLoginAttempt {
    pub fn methods(&self) -> Vec<String> {
        match &*self.state.lock().unwrap() {
            Prepared::Challenge(saved) => {
                saved.challenge.methods.iter().map(|m| authentication::method_name(*m).to_owned()).collect()
            }
            Prepared::Authenticated(..) => Vec::new(),
        }
    }
    pub fn pending_confirmation(&self) -> bool {
        matches!(&*self.state.lock().unwrap(), Prepared::Challenge(saved) if saved.pending.is_some())
    }
    pub async fn verify(&self, method: String, code: String) -> Result<(), RvError> {
        let _operation = self.operation.lock().await;
        let saved = match &*self.state.lock().unwrap() {
            Prepared::Challenge(saved) => saved.clone(),
            Prepared::Authenticated(..) => return Ok(()),
        };
        let method = match method.as_str() {
            "totp" => SecondFactor::Totp,
            "recovery_code" => SecondFactor::RecoveryCode,
            _ => return Err(error(Error::Protocol("factor_unavailable"))),
        };
        let (dirs, proof) = (self.dirs.clone(), saved.clone());
        let (result, latest) = on_tokio(async move {
            let vault = accounts::authentication_vault(&dirs);
            let result = vault.finish(&proof, method, &code).await;
            let latest = if result.is_err() {
                vault.load(&proof.base_url, &proof.user.username).await.ok().flatten()
            } else {
                None
            };
            (result, latest)
        })
        .await;
        match result {
            Ok(record) => {
                *self.state.lock().unwrap() = Prepared::Authenticated(Box::new(record), Some(saved));
                Ok(())
            }
            Err(problem) => {
                if let Some(latest) = latest
                    && latest.challenge.challenge_id == saved.challenge.challenge_id
                {
                    *self.state.lock().unwrap() = Prepared::Challenge(latest);
                }
                Err(error(problem))
            }
        }
    }
    /// Writes the accepted credential; activation belongs to the guarded UI.
    pub async fn commit(&self) -> Result<Arc<NativeChat>, RvError> {
        let _operation = self.operation.lock().await;
        if let Some(chat) = self.committed.lock().unwrap().clone() {
            // Replaying this foreign handle cannot restore a bearer that the
            // accepted session has since renewed or removed during logout.
            return Ok(chat);
        }
        let (record, proof) = match &*self.state.lock().unwrap() {
            Prepared::Authenticated(record, proof) => (record.as_ref().clone(), proof.clone()),
            Prepared::Challenge(_) => return Err(error(Error::Protocol("factor_required"))),
        };
        let (dirs, stored) = (self.dirs.clone(), record.clone());
        on_tokio(async move {
            let writing = dirs.clone();
            let actual = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                blocking(move || {
                    accounts::save_native_record(&writing, &stored)?;
                    accounts::native_record(&stored.info)
                }),
            )
            .await
            .map_err(|_| Error::Protocol("secure_storage_unavailable"))?
            .map_err(|_| Error::Protocol("secure_storage_unavailable"))?;
            if let Some(proof) = proof {
                // A cleanup failure retains recovery; it cannot undo a commit.
                let _ = accounts::authentication_vault(&dirs).clear_completed(&proof, Some(&actual.info)).await;
            }
            Ok::<(), Error>(())
        })
        .await
        .map_err(error)?;
        let chat = Client { dirs: self.dirs.clone() }.start_native(record.info)?;
        *self.committed.lock().unwrap() = Some(chat.clone());
        Ok(chat)
    }
}
