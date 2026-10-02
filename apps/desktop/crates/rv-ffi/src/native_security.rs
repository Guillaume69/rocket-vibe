//! One opaque settings handle pins an existing family. No proof candidate,
//! operation ID or credential crosses UniFFI. Private display data is transient.
use crate::{accounts, model::RvError, on_tokio};
use email::EmailDeliveryState;
use rv_core::native::{
    Error, NativeSession,
    authentication::{SecondFactor, method_name},
    security::{
        Access, EmailFactorExpectation, FactorAction, FactorState, Guard, ProofState, Remote, Scope, Status, email,
    },
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
#[derive(Clone, Copy, uniffi::Enum)]
pub enum NativeEmailPhase {
    Idle,
    Pending,
    Verified,
    Stale,
    RemovalPending,
    Removed,
    RemovalStale,
}
#[derive(Clone, Copy, uniffi::Enum)]
pub enum NativeEmailDelivery {
    Queued,
    Sending,
    Deferred,
    Accepted,
    Exhausted,
}
impl From<&EmailDeliveryState> for NativeEmailDelivery {
    fn from(value: &EmailDeliveryState) -> Self {
        match value {
            EmailDeliveryState::Queued => Self::Queued,
            EmailDeliveryState::Sending => Self::Sending,
            EmailDeliveryState::Deferred => Self::Deferred,
            EmailDeliveryState::Accepted => Self::Accepted,
            EmailDeliveryState::Exhausted => Self::Exhausted,
        }
    }
}
/// Display metadata only. No delivery/challenge IDs or code cross the ABI.
#[derive(Clone, uniffi::Record)]
pub struct NativeFactorEmailState {
    pub view_revision: u64,
    pub requested: bool,
    pub can_deliver: bool,
    pub expires_at: Option<String>,
    pub delivery: Option<NativeEmailDelivery>,
    pub resend_after_seconds: Option<u32>,
}
impl NativeFactorEmailState {
    pub(crate) fn snapshot(
        revision: u64,
        intent: Option<&rv_core::native::factor_email::Intent>,
        capable: bool,
    ) -> Self {
        let status = intent.and_then(|i| i.status.as_ref());
        Self {
            view_revision: revision,
            requested: intent.is_some(),
            can_deliver: capable,
            expires_at: status.map(|s| s.expires_at.clone()),
            delivery: status.map(|s| (&s.delivery).into()),
            resend_after_seconds: status.map(|s| s.resend_after_seconds),
        }
    }
}
/// Only display values cross the ABI; original candidates, receipt IDs, scope
/// and authority versions remain in the opaque handle and private trousseau.
#[derive(Clone, uniffi::Record)]
pub struct NativeEmailState {
    pub phase: NativeEmailPhase,
    pub can_verify: bool,
    pub can_remove: bool,
    pub address: Option<String>,
    pub pending_address: Option<String>,
    pub expires_at: Option<String>,
    pub delivery: Option<NativeEmailDelivery>,
}
impl From<&email::View> for NativeEmailState {
    fn from(view: &email::View) -> Self {
        let mut value = Self {
            phase: NativeEmailPhase::Idle,
            can_verify: false,
            can_remove: false,
            address: view.status.address.clone(),
            pending_address: None,
            expires_at: None,
            delivery: None,
        };
        value.phase = match &view.state {
            email::State::Idle => NativeEmailPhase::Idle,
            email::State::Verified { .. } => NativeEmailPhase::Verified,
            email::State::Stale { .. } => NativeEmailPhase::Stale,
            email::State::RemovalPending { .. } => NativeEmailPhase::RemovalPending,
            email::State::Removed { .. } => NativeEmailPhase::Removed,
            email::State::RemovalStale { .. } => NativeEmailPhase::RemovalStale,
            email::State::Pending { address, expires_at, delivery, .. } => {
                value.pending_address = Some(address.clone());
                value.expires_at = Some(expires_at.clone());
                value.delivery = Some(match delivery {
                    EmailDeliveryState::Queued => NativeEmailDelivery::Queued,
                    EmailDeliveryState::Sending => NativeEmailDelivery::Sending,
                    EmailDeliveryState::Deferred => NativeEmailDelivery::Deferred,
                    EmailDeliveryState::Accepted => NativeEmailDelivery::Accepted,
                    EmailDeliveryState::Exhausted => NativeEmailDelivery::Exhausted,
                });
                NativeEmailPhase::Pending
            }
        };
        value
    }
}

/// Deliberately has no Debug / serde implementation. The revision binds a UI
/// confirmation to this exact private display, even across delayed callbacks.
#[derive(Clone, uniffi::Record)]
pub struct NativeSecurityState {
    pub view_revision: u64,
    pub loaded: bool,
    pub supports_factors: bool,
    pub enabled: bool,
    pub totp_enabled: bool,
    pub email_factor_enabled: bool,
    pub supports_email_factors: bool,
    pub can_enable_email_factor: bool,
    pub backup_codes_remaining: u32,
    pub proof: NativeProofPhase,
    pub methods: Vec<String>,
    pub proof_email: Option<NativeFactorEmailState>,
    pub factor: NativeFactorPhase,
    pub setup_secret: Option<String>,
    pub setup_uri: Option<String>,
    pub codes: Vec<String>,
    pub supports_email: bool,
    pub email: Option<NativeEmailState>,
}
struct State {
    revision: u64,
    proof: ProofState,
    factor: FactorState,
    status: Option<Status>,
    email: Option<email::View>,
}
impl Default for State {
    fn default() -> Self {
        Self { revision: 0, proof: ProofState::Password, factor: FactorState::Idle, status: None, email: None }
    }
}
impl State {
    fn clear(&mut self) {
        self.proof = ProofState::Password;
        self.factor = FactorState::Idle;
        self.status = None;
        self.email = None;
    }
    fn snapshot(
        &self,
        supported: bool,
        email_features: (bool, bool),
        delivery: bool,
        email_factors: bool,
    ) -> NativeSecurityState {
        let supports_email = email_features.0 || email_features.1 || email_factors;
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
            enabled: self.status.as_ref().is_some_and(|s| s.totp || s.email),
            totp_enabled: self.status.as_ref().is_some_and(|s| s.totp),
            email_factor_enabled: self.status.as_ref().is_some_and(|s| s.email),
            supports_email_factors: email_factors,
            can_enable_email_factor: email_factors && delivery,
            backup_codes_remaining: self.status.as_ref().map(|s| s.backup_codes_remaining).unwrap_or_default(),
            proof,
            methods,
            proof_email: match &self.proof {
                ProofState::Challenge(saved)
                    if saved
                        .challenge()
                        .is_some_and(|c| c.methods.iter().any(|m| matches!(m, SecondFactor::Email))) =>
                {
                    Some(NativeFactorEmailState::snapshot(self.revision, saved.email(), delivery))
                }
                _ => None,
            },
            factor,
            setup_secret: secret,
            setup_uri: uri,
            codes,
            supports_email,
            email: if supports_email {
                self.email.as_ref().map(|view| {
                    let mut email = NativeEmailState::from(view);
                    (email.can_verify, email.can_remove) = email_features;
                    email
                })
            } else {
                None
            },
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
    ProofEmail(bool, u64),
    Factor(NativeFactorAction, u64),
    EmailFactor(bool, u64),
    Enable(String, u64),
    Clear(u64),
    EmailStart(String, u64),
    EmailRemove(u64),
    EmailConfirm(String, u64),
    EmailCancel(u64),
    EmailAcknowledge(u64),
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
            let proof_email = matches!(action, Action::ProofEmail(..));
            let mut action = Some(action);
            for attempt in 0..3 {
                inner.guard.check()?;
                let result = inner.apply(action.take().unwrap()).await;
                if proof_email && result.is_err() && inner.guard.alive() {
                    // Read the original private candidate after an ambiguous
                    // delivery. Refresh cannot request or resend an OTP.
                    let _ = inner.apply(Action::Refresh).await;
                }
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
                inner.wait_connected().await?;
                action = Some(Action::Refresh);
            }
            unreachable!()
        })
        .await
        .map_err(error)
    }
}
impl Inner {
    async fn wait_connected(&self) -> Result<(), Error> {
        for _ in 0..200 {
            self.guard.check()?;
            if self.session.is_closed() {
                return Err(Error::Protocol("session_closed"));
            }
            if self.session.status().connection == rv_core::session::Connection::Online {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        Err(Error::Protocol("offline"))
    }
    // Reading the same private receipt may cross the asynchronous socket fence
    // caused by a successful factor change. Retry only this read, keeping the
    // displayed revision, family, receipt and view guard unchanged.
    async fn copy(&self, kind: NativeSecurityCopy, revision: u64) -> Result<String, Error> {
        self.guard.check()?;
        let expected = {
            let state = self.state.lock().unwrap();
            state.revision(revision)?;
            match (&state.factor, kind) {
                (FactorState::Setup(setup), NativeSecurityCopy::Secret | NativeSecurityCopy::Uri) => {
                    setup.setup_id.clone()
                }
                (FactorState::Codes { receipt_id, .. }, NativeSecurityCopy::Codes) => receipt_id.clone(),
                _ => return Err(Error::Protocol("credentials_changed")),
            }
        };
        for attempt in 0..3 {
            self.guard.check()?;
            self.state.lock().unwrap().revision(revision)?;
            let result = self.copy_receipt(kind, &expected).await;
            let retry = result.as_ref().is_err_and(|e| matches!(e.code(), "offline" | "session_closed"));
            if !retry || !self.guard.alive() || self.session.is_closed() || attempt == 2 {
                if result.as_ref().is_err_and(|e| matches!(e.code(), "server_identity_changed" | "session_rejected")) {
                    self.guard.cancel();
                    self.state.lock().unwrap().clear();
                }
                return result;
            }
            self.wait_connected().await?;
        }
        unreachable!()
    }
    async fn copy_receipt(&self, kind: NativeSecurityCopy, expected: &str) -> Result<String, Error> {
        let access = self.access().await?;
        let fresh = accounts::security_vault(&self.dirs).factor_resume(&self.scope, &access, &self.guard).await?;
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
    }
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
        let mut email = None;
        match action {
            Action::Refresh => {
                proof = Some(vault.prepare(scope, &access, "", guard).await?);
                if self.session.factors_supported() || self.session.email_factors_supported() {
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
            Action::ProofEmail(resend, revision) => {
                let saved = {
                    let state = self.state.lock().unwrap();
                    state.revision(revision)?;
                    match &state.proof {
                        ProofState::Challenge(saved) => (**saved).clone(),
                        _ => return Err(Error::Protocol("reauthentication_rejected")),
                    }
                };
                proof = Some(vault.send_email(&saved, &access, resend, guard).await?);
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
            Action::EmailFactor(enabled, revision) => {
                if !self.session.email_factors_supported() {
                    return Err(Error::Protocol("unsupported_feature"));
                }
                let expected = {
                    let state = self.state.lock().unwrap();
                    state.revision(revision)?;
                    let view = state.email.as_ref().ok_or(Error::Protocol("credentials_changed"))?;
                    if !matches!(view.state, email::State::Idle) || !matches!(state.factor, FactorState::Idle) {
                        return Err(Error::Protocol("credentials_changed"));
                    }
                    EmailFactorExpectation {
                        contact: view.status.clone(),
                        factors: state.status.clone().ok_or(Error::Protocol("credentials_changed"))?,
                        enabled,
                    }
                };
                factor = Some(vault.factor_email_start(scope, &access, &expected, guard).await?);
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
            Action::EmailStart(address, revision) => {
                if !self.session.email_verification_supported() {
                    return Err(Error::Protocol("unsupported_feature"));
                }
                let expected = {
                    let state = self.state.lock().unwrap();
                    state.revision(revision)?;
                    let view = state.email.as_ref().ok_or(Error::Protocol("credentials_changed"))?;
                    if !matches!(view.state, email::State::Idle) {
                        return Err(Error::Protocol("credentials_changed"));
                    }
                    view.status.clone()
                };
                email = Some(vault.email_start(scope, &access, &address, &expected, guard).await?);
            }
            Action::EmailRemove(revision) => {
                if !self.session.email_removal_supported() {
                    return Err(Error::Protocol("unsupported_feature"));
                }
                let expected = {
                    let state = self.state.lock().unwrap();
                    state.revision(revision)?;
                    let view = state.email.as_ref().ok_or(Error::Protocol("credentials_changed"))?;
                    if !matches!(view.state, email::State::Idle) || view.status.address.is_none() {
                        return Err(Error::Protocol("credentials_changed"));
                    }
                    view.status.clone()
                };
                email = Some(vault.email_remove(scope, &access, &expected, guard).await?);
            }
            Action::EmailConfirm(code, revision) => {
                let receipt = self.email_receipt(revision, NativeEmailPhase::Pending)?;
                email = Some(vault.email_confirm(scope, &access, &receipt, &code, guard).await?);
            }
            Action::EmailCancel(revision) => {
                let receipt = self.email_receipt(revision, NativeEmailPhase::Stale)?;
                email = Some(vault.email_cancel(scope, &access, &receipt, guard).await?);
            }
            Action::EmailAcknowledge(revision) => {
                let receipt = self.email_receipt(revision, NativeEmailPhase::Verified)?;
                email = Some(vault.email_acknowledge(scope, &access, &receipt, guard).await?);
            }
        }
        if email.is_none() && self.session.email_supported() {
            email = Some(vault.email_resume(scope, &access, guard).await?);
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
        state.email = email;
        Ok(state.snapshot(
            self.session.factors_supported(),
            (self.session.email_verification_supported(), self.session.email_removal_supported()),
            self.session.email_factor_delivery_supported(),
            self.session.email_factors_supported(),
        ))
    }
    fn email_receipt(&self, revision: u64, phase: NativeEmailPhase) -> Result<String, Error> {
        let state = self.state.lock().unwrap();
        state.revision(revision)?;
        let view = state.email.as_ref().ok_or(Error::Protocol("credentials_changed"))?;
        let allowed = matches!(
            (&view.state, phase),
            (email::State::Pending { .. }, NativeEmailPhase::Pending | NativeEmailPhase::Stale)
                | (email::State::Stale { .. }, NativeEmailPhase::Stale)
                | (email::State::Verified { .. }, NativeEmailPhase::Verified)
                | (email::State::RemovalPending { .. } | email::State::RemovalStale { .. }, NativeEmailPhase::Stale)
                | (email::State::Removed { .. }, NativeEmailPhase::Verified)
        );
        if !allowed {
            return Err(Error::Protocol("credentials_changed"));
        }
        view.state.receipt().map(str::to_owned).ok_or(Error::Protocol("credentials_changed"))
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
        state.snapshot(
            self.inner.session.factors_supported(),
            (self.inner.session.email_verification_supported(), self.inner.session.email_removal_supported()),
            self.inner.session.email_factor_delivery_supported(),
            self.inner.session.email_factors_supported(),
        )
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
    pub async fn send_proof_email(&self, resend: bool, view_revision: u64) -> Result<NativeSecurityState, RvError> {
        self.perform(Action::ProofEmail(resend, view_revision)).await
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
    pub async fn email_factor_action(&self, enabled: bool, view_revision: u64) -> Result<NativeSecurityState, RvError> {
        self.perform(Action::EmailFactor(enabled, view_revision)).await
    }
    pub async fn acknowledge(&self, view_revision: u64) -> Result<NativeSecurityState, RvError> {
        self.perform(Action::Clear(view_revision)).await
    }
    pub async fn start_email(&self, address: String, view_revision: u64) -> Result<NativeSecurityState, RvError> {
        self.perform(Action::EmailStart(address, view_revision)).await
    }
    pub async fn remove_email(&self, view_revision: u64) -> Result<NativeSecurityState, RvError> {
        self.perform(Action::EmailRemove(view_revision)).await
    }
    pub async fn confirm_email(&self, code: String, view_revision: u64) -> Result<NativeSecurityState, RvError> {
        self.perform(Action::EmailConfirm(code, view_revision)).await
    }
    pub async fn cancel_email(&self, view_revision: u64) -> Result<NativeSecurityState, RvError> {
        self.perform(Action::EmailCancel(view_revision)).await
    }
    pub async fn acknowledge_email(&self, view_revision: u64) -> Result<NativeSecurityState, RvError> {
        self.perform(Action::EmailAcknowledge(view_revision)).await
    }
    pub async fn copy(&self, kind: NativeSecurityCopy, view_revision: u64) -> Result<String, RvError> {
        let inner = self.inner.clone();
        on_tokio(async move {
            let _operation = inner.operation.lock().await;
            inner.copy(kind, view_revision).await
        })
        .await
        .map_err(error)
    }
}
