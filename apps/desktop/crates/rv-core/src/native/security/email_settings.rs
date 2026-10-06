//! Explicit email-factor changes share the proof/contact/TOTP OS lease and
//! private receipt key. Pin the displayed contact and installed profile version.
use super::{
    Error, FactorIntent, FactorState, Guard, NativeSession, Remote, Scope, Vault, identifier, invalid, random_token,
};
use rv_protocol::parity::{ChangeEmailFactor, EmailStatus, FactorBackupCodes, FactorStatus};
use std::{fs::File, sync::Arc};

/// The user's displayed approval. It contains private contact presentation data
/// and intentionally implements neither Debug nor serialisation.
#[derive(Clone)]
pub struct EmailFactorExpectation {
    pub contact: EmailStatus,
    pub factors: FactorStatus,
    pub enabled: bool,
}
impl NativeSession {
    pub fn email_factors_supported(&self) -> bool {
        self.capabilities
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|c| c.reauthentication && c.reauthentication_retirement && c.email_factors)
    }
}
fn contact(scope: &Scope, value: &EmailStatus) -> Result<(), Error> {
    super::email::check_status(scope, value)
}
impl Vault {
    pub async fn factor_email_start(
        &self,
        scope: &Scope,
        remote: &dyn Remote,
        expected: &EmailFactorExpectation,
        guard: &Guard,
    ) -> Result<FactorState, Error> {
        contact(scope, &expected.contact)?;
        let key = scope.key()?;
        let lease = self.lease(&key, guard).await?;
        // An existing approved operation/receipt always wins. Another profile
        // change cannot replace its bag or private intent before acknowledgement.
        if self.read_factor(&key, scope, lease.clone(), guard).await?.is_some() {
            return self.recover_factor(&key, scope, remote, lease, guard).await;
        }
        let status = self.factor_status(scope, remote, guard).await?;
        if status.factor_version.is_some() != (status.totp || status.email)
            || status.factor_version.as_ref().is_some_and(|v| !identifier(v))
        {
            return Err(invalid());
        }
        let current = remote.contact_status().await?;
        guard.check()?;
        contact(scope, &current)?;
        if current.version != expected.contact.version
            || current.address != expected.contact.address
            || current.address.as_ref().is_none_or(|a| a.is_empty() || a.len() > 254)
            || status.email != expected.factors.email
            || status.totp != expected.factors.totp
            || status.factor_version != expected.factors.factor_version
            || status.email == expected.enabled
        {
            return Err(Error::Protocol("credentials_changed"));
        }
        self.write_factor(
            &key,
            scope,
            FactorIntent::Email {
                operation_id: random_token()?,
                email_version: current.version,
                factor_version: status.factor_version,
                enabled: expected.enabled,
            },
            lease.clone(),
            guard,
        )
        .await?;
        self.recover_factor(&key, scope, remote, lease, guard).await
    }
    pub(super) async fn recover_email_factor(
        &self,
        key: &str,
        scope: &Scope,
        (input, enabled): (ChangeEmailFactor, bool),
        remote: &dyn Remote,
        lease: Arc<File>,
        guard: &Guard,
    ) -> Result<FactorState, Error> {
        guard.check()?;
        let result = remote.change_email_factor(input.clone(), enabled).await;
        guard.check()?;
        let receipt = match result {
            Ok(receipt) => receipt,
            Err(Error::Network(rv_client::Error::Server { status: 409, .. })) => {
                return Ok(FactorState::Stale { receipt_id: input.operation_id });
            }
            Err(error) => return Err(error),
        };
        scope.matches(
            &receipt.context.user_id,
            &receipt.context.device_id,
            &receipt.context.instance_id,
            &receipt.context.data_epoch,
        )?;
        if receipt.enabled != enabled
            || receipt.email_version != input.email_version
            || !identifier(&receipt.factor_version)
            || receipt.codes.len() != if enabled { 10 } else { 0 }
            || receipt.codes.iter().any(|c| c.is_empty() || c.len() > 128)
        {
            return Err(invalid());
        }
        if enabled {
            return self
                .bag(
                    key,
                    scope,
                    (
                        input.operation_id,
                        FactorBackupCodes { codes: receipt.codes, factor_version: Some(receipt.factor_version) },
                    ),
                    remote,
                    lease,
                    guard,
                )
                .await;
        }
        let status = self.factor_status(scope, remote, guard).await?;
        if status.email || status.factor_version.as_ref().is_some_and(|v| v != &receipt.factor_version) {
            return Ok(FactorState::Stale { receipt_id: input.operation_id });
        }
        self.storage.remove(format!("{key}-factors"), lease).await?;
        guard.check()?;
        Ok(FactorState::Idle)
    }
}
