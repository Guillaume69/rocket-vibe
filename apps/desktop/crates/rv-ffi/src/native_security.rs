//! One opaque settings handle pins an existing family. No proof candidate,
//! operation ID or credential crosses UniFFI. Private display data is transient.
use crate::{accounts, model::RvError, on_tokio};
use rv_core::native::{
    Error, NativeSession,
    authentication::{SecondFactor, method_name},
    security::{Access, FactorAction, FactorState, Guard, ProofState, Remote, Scope, Status},
};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, uniffi::Enum)]
pub enum NativeProofPhase {
    Password,
    Challenge,
    Ready,
}
#[derive(Clone, Copy, uniffi::Enum)]
pub enum NativeFactorPhase {
    Idle,
    Setup,
    Codes,
    Stale,
}
#[derive(Clone, Copy, uniffi::Enum)]
pub enum NativeFactorAction {
    Setup,
    Regenerate,
    Disable,
}
#[derive(Clone, Copy, uniffi::Enum)]
pub enum NativeSecurityCopy {
    Secret,
    Uri,
    Codes,
}

/// Deliberately has no Debug / serde implementation. The revision binds a UI
/// confirmation to this exact private display, even across delayed callbacks.
#[derive(Clone, uniffi::Record)]
pub struct NativeSecurityState {
    pub view_revision: u64,
    pub loaded: bool,
    pub supports_factors: bool,
    pub enabled: bool,
    pub backup_codes_remaining: u32,
    pub proof: NativeProofPhase,
    pub methods: Vec<String>,
    pub factor: NativeFactorPhase,
    pub setup_secret: Option<String>,
    pub setup_uri: Option<String>,
    pub codes: Vec<String>,
}
struct State {
    revision: u64,
    proof: ProofState,
    factor: FactorState,
    status: Option<Status>,
}
impl Default for State {
    fn default() -> Self {
        Self { revision: 0, proof: ProofState::Password, factor: FactorState::Idle, status: None }
    }
}
impl State {
    fn clear(&mut self) {
        self.proof = ProofState::Password;
        self.factor = FactorState::Idle;
        self.status = None;
    }
    fn snapshot(&self, supported: bool) -> NativeSecurityState {
        let (proof, methods) = match &self.proof {
            ProofState::Ready => (NativeProofPhase::Ready, vec![]),
            ProofState::Password => (NativeProofPhase::Password, vec![]),
            ProofState::Challenge(saved) => (
                NativeProofPhase::Challenge,
                saved
                    .challenge()
                    .map(|c| c.methods.iter().map(|m| method_name(*m).into()).collect())
                    .unwrap_or_default(),
            ),
        };
        let (factor, secret, uri, codes) = match &self.factor {
            FactorState::Idle => (NativeFactorPhase::Idle, None, None, vec![]),
            FactorState::Stale { .. } => (NativeFactorPhase::Stale, None, None, vec![]),
            FactorState::Setup(setup) => {
                (NativeFactorPhase::Setup, Some(setup.secret.clone()), Some(setup.provisioning_uri.clone()), vec![])
            }
            FactorState::Codes { codes, .. } => (NativeFactorPhase::Codes, None, None, codes.codes.clone()),
        };
        NativeSecurityState {
            view_revision: self.revision,
            loaded: self.status.is_some(),
            supports_factors: supported,
            enabled: self.status.as_ref().is_some_and(|s| s.totp),
            backup_codes_remaining: self.status.as_ref().map(|s| s.backup_codes_remaining).unwrap_or_default(),
            proof,
            methods,
            factor,
            setup_secret: secret,
            setup_uri: uri,
            codes,
        }
    }
    fn revision(&self, expected: u64) -> Result<(), Error> {
        if self.status.is_some() && self.revision == expected {
            Ok(())
        } else {
            Err(Error::Protocol("credentials_changed"))
        }
    }
}
struct Inner {
    session: Arc<NativeSession>,
    dirs: Arc<accounts::Dirs>,
    scope: Scope,
    guard: Guard,
    state: Mutex<State>,
    // Taken INSIDE the actual Tokio job, retained after foreign cancellation.
    operation: tokio::sync::Mutex<()>,
}
#[derive(uniffi::Object)]
pub struct NativeSecurity {
    inner: Arc<Inner>,
}
impl Drop for NativeSecurity {
    fn drop(&mut self) {
        self.close();
    }
}
enum Action {
    Refresh,
    Password(String),
    Proof(String, String),
    Factor(NativeFactorAction, u64),
    Enable(String, u64),
    Clear(u64),
}
fn error(error: Error) -> RvError {
    rv_core::native::rest_error(error).into()
}
impl NativeSecurity {
    pub(crate) async fn open(session: Arc<NativeSession>, dirs: Arc<accounts::Dirs>) -> Result<Arc<Self>, Error> {
        let guard = Guard::new();
        let access = session.security(guard.clone()).await?;
        Ok(Arc::new(Self {
            inner: Arc::new(Inner {
                scope: access.scope().clone(),
                session,
                dirs,
                guard,
                state: Mutex::default(),
                operation: tokio::sync::Mutex::new(()),
            }),
        }))
    }
    async fn perform(&self, action: Action) -> Result<NativeSecurityState, RvError> {
        let inner = self.inner.clone();
        on_tokio(async move {
            let _operation = inner.operation.lock().await;
            let refresh = matches!(action, Action::Refresh);
            let mut action = Some(action);
            for attempt in 0..3 {
                inner.guard.check()?;
                let result = inner.apply(action.take().unwrap()).await;
                let retry = result.as_ref().is_err_and(|e| matches!(e.code(), "offline" | "session_closed"));
                if !refresh || !retry || inner.session.is_closed() || attempt == 2 {
                    if result.as_ref().is_err_and(|e| e.code() == "reauthentication_required") {
                        inner.state.lock().unwrap().proof = ProofState::Password;
                    }
                    if result
                        .as_ref()
                        .is_err_and(|e| matches!(e.code(), "server_identity_changed" | "session_rejected"))
                    {
                        inner.guard.cancel();
                    }
                    if result.as_ref().is_err_and(|e| {
                        matches!(e.code(), "session_closed" | "server_identity_changed" | "session_rejected")
                    }) {
                        inner.state.lock().unwrap().clear();
                    }
                    return result;
                }
                for _ in 0..200 {
                    inner.guard.check()?;
                    if inner.session.is_closed() {
                        return Err(Error::Protocol("session_closed"));
                    }
                    if inner.session.status().connection == rv_core::session::Connection::Online {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                action = Some(Action::Refresh);
            }
            unreachable!()
        })
        .await
        .map_err(error)
    }
}
impl Inner {
    async fn access(&self) -> Result<Access, Error> {
        self.guard.check()?;
        let access = self.session.security(self.guard.clone()).await?;
        if access.scope() != &self.scope {
            return Err(Error::Protocol("server_identity_changed"));
        }
        Ok(access)
    }
    async fn apply(&self, action: Action) -> Result<NativeSecurityState, Error> {
        let access = self.access().await?;
        let vault = accounts::security_vault(&self.dirs);
        let (scope, guard) = (&self.scope, &self.guard);
        let mut proof = None;
        let mut factor = None;
        match action {
            Action::Refresh => {
                proof = Some(vault.prepare(scope, &access, "", guard).await?);
                if self.session.factors_supported() {
                    factor = Some(vault.factor_resume(scope, &access, guard).await?);
                }
            }
            Action::Password(password) => proof = Some(vault.prepare(scope, &access, &password, guard).await?),
            Action::Proof(method, code) => {
                let saved = match &self.state.lock().unwrap().proof {
                    ProofState::Challenge(saved) => (**saved).clone(),
                    _ => return Err(Error::Protocol("reauthentication_rejected")),
                };
                let method = match method.as_str() {
                    "totp" => SecondFactor::Totp,
                    "recovery_code" => SecondFactor::RecoveryCode,
                    "email" => SecondFactor::Email,
                    _ => return Err(Error::Protocol("reauthentication_rejected")),
                };
                proof = Some(vault.finish(&saved, &access, method, &code, guard).await?);
            }
            Action::Factor(action, revision) => {
                self.state.lock().unwrap().revision(revision)?;
                let action = match action {
                    NativeFactorAction::Setup => FactorAction::Setup,
                    NativeFactorAction::Regenerate => FactorAction::Regenerate,
                    NativeFactorAction::Disable => FactorAction::Disable,
                };
                factor = Some(vault.factor_start(scope, &access, action, guard).await?);
            }
            Action::Enable(code, revision) => {
                let setup = {
                    let state = self.state.lock().unwrap();
                    state.revision(revision)?;
                    match &state.factor {
                        FactorState::Setup(setup) => (**setup).clone(),
                        _ => return Err(Error::Protocol("credentials_changed")),
                    }
                };
                factor = Some(vault.factor_enable(scope, &access, &setup, &code, guard).await?);
            }
            Action::Clear(revision) => {
                let receipt = {
                    let state = self.state.lock().unwrap();
                    state.revision(revision)?;
                    match &state.factor {
                        FactorState::Codes { receipt_id, .. } | FactorState::Stale { receipt_id } => receipt_id.clone(),
                        _ => return Err(Error::Protocol("credentials_changed")),
                    }
                };
                if !vault.factor_clear(scope, &receipt, guard).await? {
                    return Err(Error::Protocol("credentials_changed"));
                }
                factor = Some(FactorState::Idle);
            }
        }
        let status = access.factor_status().await?;
        let recent = access.status().await?.recent;
        access.check()?;
        let mut state = self.state.lock().unwrap();
        self.guard.check()?;
        state.revision = state.revision.checked_add(1).ok_or(Error::Protocol("invalid_native_security"))?;
        if let Some(proof) = proof {
            state.proof = proof;
        }
        if !recent && matches!(state.proof, ProofState::Ready) {
            state.proof = ProofState::Password;
        }
        if let Some(factor) = factor {
            state.factor = factor;
        } else if let FactorState::Codes { receipt_id, codes } = &state.factor
            && codes.factor_version != status.factor_version
        {
            state.factor = FactorState::Stale { receipt_id: receipt_id.clone() };
        }
        state.status = Some(status);
        Ok(state.snapshot(self.session.factors_supported()))
    }
}
#[uniffi::export]
impl NativeSecurity {
    pub fn is_closed(&self) -> bool {
        !self.inner.guard.alive() || self.inner.session.is_closed()
    }
    pub fn close(&self) {
        self.inner.guard.cancel();
        self.inner.state.lock().unwrap().clear();
    }
    pub fn state(&self) -> NativeSecurityState {
        let mut state = self.inner.state.lock().unwrap();
        if !self.inner.guard.alive() || self.inner.session.is_closed() {
            state.clear();
        }
        state.snapshot(self.inner.session.factors_supported())
    }
    pub async fn refresh(&self) -> Result<NativeSecurityState, RvError> {
        self.perform(Action::Refresh).await
    }
    pub async fn confirm_password(&self, password: String) -> Result<NativeSecurityState, RvError> {
        self.perform(Action::Password(password)).await
    }
    pub async fn confirm_factor(&self, method: String, code: String) -> Result<NativeSecurityState, RvError> {
        self.perform(Action::Proof(method, code)).await
    }
    pub async fn factor_action(
        &self,
        action: NativeFactorAction,
        view_revision: u64,
    ) -> Result<NativeSecurityState, RvError> {
        self.perform(Action::Factor(action, view_revision)).await
    }
    pub async fn enable(&self, code: String, view_revision: u64) -> Result<NativeSecurityState, RvError> {
        self.perform(Action::Enable(code, view_revision)).await
    }
    pub async fn acknowledge(&self, view_revision: u64) -> Result<NativeSecurityState, RvError> {
        self.perform(Action::Clear(view_revision)).await
    }
    pub async fn copy(&self, kind: NativeSecurityCopy, view_revision: u64) -> Result<String, RvError> {
        let inner = self.inner.clone();
        on_tokio(async move {
            let _operation = inner.operation.lock().await;
            let access = inner.access().await?;
            let expected = {
                let state = inner.state.lock().unwrap();
                state.revision(view_revision)?;
                match (&state.factor, kind) {
                    (FactorState::Setup(setup), NativeSecurityCopy::Secret | NativeSecurityCopy::Uri) => {
                        setup.setup_id.clone()
                    }
                    (FactorState::Codes { receipt_id, .. }, NativeSecurityCopy::Codes) => receipt_id.clone(),
                    _ => return Err(Error::Protocol("credentials_changed")),
                }
            };
            let fresh =
                accounts::security_vault(&inner.dirs).factor_resume(&inner.scope, &access, &inner.guard).await?;
            let text = match (fresh, kind) {
                (FactorState::Setup(setup), NativeSecurityCopy::Secret) if setup.setup_id == expected => setup.secret,
                (FactorState::Setup(setup), NativeSecurityCopy::Uri) if setup.setup_id == expected => {
                    setup.provisioning_uri
                }
                (FactorState::Codes { receipt_id, codes }, NativeSecurityCopy::Codes) if receipt_id == expected => {
                    codes.codes.join("\n")
                }
                _ => return Err(Error::Protocol("credentials_changed")),
            };
            access.check()?;
            Ok(text)
        })
        .await
        .map_err(error)
    }
}
