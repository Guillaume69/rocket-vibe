//! Opaque pre-authentication proof. Swift never receives its bearer or candidate.
use crate::{
    Client, accounts, blocking, model::RvError, native::NativeChat, native_security::NativeFactorEmailState, on_tokio,
};
use rv_core::native::{
    Error,
    authentication::{self, SecondFactor},
    authentication_vault::Prepared,
    security::Guard,
};
use std::sync::{Arc, Mutex};

#[derive(uniffi::Object)]
pub struct NativeLoginAttempt {
    dirs: Arc<accounts::Dirs>,
    state: Arc<Mutex<State>>,
    operation: Arc<tokio::sync::Mutex<()>>,
    committed: Mutex<Option<Arc<NativeChat>>>,
    guard: Guard,
}
struct State {
    step: Prepared,
    revision: u64,
    email_capable: bool,
}
impl State {
    fn email(&self) -> Option<NativeFactorEmailState> {
        match &self.step {
            Prepared::Challenge(saved) if saved.challenge.methods.iter().any(|m| matches!(m, SecondFactor::Email)) => {
                Some(NativeFactorEmailState::snapshot(self.revision, saved.email.as_ref(), self.email_capable))
            }
            _ => None,
        }
    }
    fn update(&mut self, step: Prepared) -> Result<(), Error> {
        self.revision = self.revision.checked_add(1).ok_or(Error::Protocol("invalid_native_authentication"))?;
        self.step = step;
        Ok(())
    }
}
impl Drop for NativeLoginAttempt {
    fn drop(&mut self) {
        self.guard.cancel();
    }
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
            let prepared = accounts::authentication_vault(&dirs).prepare(step).await?;
            Ok::<_, Error>(State {
                step: prepared,
                revision: 0,
                email_capable: discovery.capabilities.email_factor_delivery,
            })
        })
        .await
        .map_err(error)?;
        Ok(Arc::new(NativeLoginAttempt {
            dirs: self.dirs.clone(),
            state: Arc::new(Mutex::new(state)),
            operation: Arc::new(tokio::sync::Mutex::new(())),
            committed: Mutex::default(),
            guard: Guard::new(),
        }))
    }
}

#[uniffi::export]
impl NativeLoginAttempt {
    pub fn methods(&self) -> Vec<String> {
        if !self.guard.alive() {
            return Vec::new();
        }
        match &self.state.lock().unwrap().step {
            Prepared::Challenge(saved) => {
                saved.challenge.methods.iter().map(|m| authentication::method_name(*m).to_owned()).collect()
            }
            Prepared::Authenticated(..) => Vec::new(),
        }
    }
    pub fn pending_confirmation(&self) -> bool {
        self.guard.alive()
            && matches!(&self.state.lock().unwrap().step, Prepared::Challenge(saved) if saved.pending.is_some())
    }
    pub fn close(&self) {
        self.guard.cancel();
    }
    pub fn email_delivery(&self) -> Option<NativeFactorEmailState> {
        if !self.guard.alive() {
            return None;
        }
        self.state.lock().unwrap().email()
    }
    pub async fn send_email(&self, resend: bool, view_revision: u64) -> Result<NativeFactorEmailState, RvError> {
        let (dirs, state, operation, guard) =
            (self.dirs.clone(), self.state.clone(), self.operation.clone(), self.guard.clone());
        on_tokio(async move {
            // The actual job owns this lease after a foreign caller cancels.
            let _operation = operation.lock().await;
            guard.check()?;
            let saved = {
                let state = state.lock().unwrap();
                if state.revision != view_revision {
                    return Err(Error::Protocol("credentials_changed"));
                }
                match &state.step {
                    Prepared::Challenge(saved) => saved.clone(),
                    _ => return Err(Error::Protocol("factor_required")),
                }
            };
            let vault = accounts::authentication_vault(&dirs);
            let result = vault.send_email(&saved, resend, &guard).await;
            let latest = match &result {
                Ok(latest) => Some(latest.clone()),
                Err(_) if guard.alive() => vault.load(&saved.base_url, &saved.user.username).await.ok().flatten(),
                _ => None,
            };
            guard.check()?;
            let mut state = state.lock().unwrap();
            if let Some(latest) = latest
                && latest.challenge.challenge_id == saved.challenge.challenge_id
                && latest.identity == saved.identity
                && latest.user.id == saved.user.id
            {
                state.update(Prepared::Challenge(latest))?;
            }
            result?;
            state.email().ok_or(Error::Protocol("factor_unavailable"))
        })
        .await
        .map_err(error)
    }
    pub async fn verify(&self, method: String, code: String) -> Result<(), RvError> {
        let _operation = self.operation.lock().await;
        self.guard.check().map_err(error)?;
        let saved = match &self.state.lock().unwrap().step {
            Prepared::Challenge(saved) => saved.clone(),
            Prepared::Authenticated(..) => return Ok(()),
        };
        let method = match method.as_str() {
            "totp" => SecondFactor::Totp,
            "recovery_code" => SecondFactor::RecoveryCode,
            "email" => SecondFactor::Email,
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
        self.guard.check().map_err(error)?;
        match result {
            Ok(record) => {
                self.state
                    .lock()
                    .unwrap()
                    .update(Prepared::Authenticated(Box::new(record), Some(saved)))
                    .map_err(error)?;
                Ok(())
            }
            Err(problem) => {
                if let Some(latest) = latest
                    && latest.challenge.challenge_id == saved.challenge.challenge_id
                {
                    self.state.lock().unwrap().update(Prepared::Challenge(latest)).map_err(error)?;
                }
                Err(error(problem))
            }
        }
    }
    /// Writes the accepted credential; activation belongs to the guarded UI.
    pub async fn commit(&self) -> Result<Arc<NativeChat>, RvError> {
        let _operation = self.operation.lock().await;
        self.guard.check().map_err(error)?;
        if let Some(chat) = self.committed.lock().unwrap().clone() {
            // Replaying this foreign handle cannot restore a bearer that the
            // accepted session has since renewed or removed during logout.
            return Ok(chat);
        }
        let (record, proof) = match &self.state.lock().unwrap().step {
            Prepared::Authenticated(record, proof) => (record.as_ref().clone(), proof.clone()),
            Prepared::Challenge(_) => return Err(error(Error::Protocol("factor_required"))),
        };
        let (dirs, stored, guard) = (self.dirs.clone(), record.clone(), self.guard.clone());
        on_tokio(async move {
            let writing = dirs.clone();
            let actual = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                blocking(move || {
                    guard.check().map_err(|e| e.code().to_owned())?;
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
        self.guard.check().map_err(error)?;
        let chat = Client { dirs: self.dirs.clone() }.start_native(record.info)?;
        *self.committed.lock().unwrap() = Some(chat.clone());
        Ok(chat)
    }
}
