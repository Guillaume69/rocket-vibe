//! Removing a contact uses the same private intent slot and OS lease as its
//! verification. The record contains no former address or credential.
use super::{
    Accepted, Error, Guard, Remote, Scope, State, Vault, View, check_status, identifier, invalid, nonce, random_token,
};
use rv_protocol::parity::{
    EmailRemovalReceipt, EmailStatus, RemoveVerifiedEmail, ResumeEmailRemoval, RetireEmailRemoval,
};
use serde::{Deserialize, Serialize};
use std::{fs::File, sync::Arc};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Removal,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {
    kind: Kind,
    pub(super) scope: Scope,
    pub(super) input: RemoveVerifiedEmail,
    pub(super) accepted: Option<Accepted>,
}
impl Record {
    pub(super) fn validate(&self, scope: &Scope) -> Result<(), Error> {
        self.scope.validate()?;
        let input = &self.input;
        if self.scope != *scope
            || !nonce(&input.operation_id)
            || !identifier(&input.expected_version)
            || !identifier(&input.verification_version)
            || self.accepted.as_ref().is_some_and(|a| !valid_accepted(a, input))
        {
            return Err(invalid());
        }
        let c = &input.context;
        scope.matches(&c.user_id, &c.device_id, &c.instance_id, &c.data_epoch).map_err(|_| invalid())
    }
    fn resume(&self) -> ResumeEmailRemoval {
        ResumeEmailRemoval { operation_id: self.input.operation_id.clone(), context: self.scope.context() }
    }
}
fn valid_accepted(value: &Accepted, input: &RemoveVerifiedEmail) -> bool {
    identifier(&value.version)
        && identifier(&value.head)
        && value.version != input.expected_version
        && value.head != input.verification_version
}
fn missing(error: &Error) -> bool {
    matches!(error,Error::Network(rv_client::Error::Server{status:400,code,..}) if code=="email_removal_rejected")
}
fn stale(error: &Error) -> bool {
    missing(error) || super::conflict(error) || super::invalid_start(error)
}
fn proof_needed(error: &Error) -> bool {
    matches!(error,Error::Network(rv_client::Error::Server{status:403,code,..}) if code=="reauthentication_required")
}
fn unconfirmed(error: &Error) -> bool {
    proof_needed(error)
        || matches!(
            error,
            Error::Protocol("network_or_protocol_error" | "offline") | Error::Network(rv_client::Error::Transport(_))
        )
        || matches!(error,Error::Network(rv_client::Error::Server{status,..}) if *status>=500)
}
impl Vault {
    async fn write_email_removal(
        &self,
        key: &str,
        record: &Record,
        lease: Arc<File>,
        guard: &Guard,
    ) -> Result<(), Error> {
        record.validate(&record.scope)?;
        guard.check()?;
        self.storage
            .write(format!("{key}-email"), serde_json::to_string(record).map_err(|_| invalid())?, lease)
            .await?;
        guard.check()
    }
    async fn received_email_removal(
        &self,
        key: &str,
        mut saved: Record,
        receipt: EmailRemovalReceipt,
        remote: &dyn Remote,
        lease: Arc<File>,
        guard: &Guard,
    ) -> Result<View, Error> {
        let c = &receipt.context;
        saved.scope.matches(&c.user_id, &c.device_id, &c.instance_id, &c.data_epoch)?;
        let accepted = Accepted { version: receipt.version, head: receipt.verification_version };
        if !valid_accepted(&accepted, &saved.input) {
            return Err(invalid());
        }
        let status = self.live_email(&saved.scope, remote, guard).await?;
        if status.address.is_some()
            || status.version != accepted.version
            || status.verification_version != accepted.head
        {
            return Err(Error::Protocol("credentials_changed"));
        }
        saved.accepted = Some(accepted);
        self.write_email_removal(key, &saved, lease, guard).await?;
        Ok(View { status, state: State::Removed { receipt_id: saved.input.operation_id } })
    }
    pub(super) async fn recover_email_removal(
        &self,
        key: &str,
        saved: Record,
        status: EmailStatus,
        remote: &dyn Remote,
        lease: Arc<File>,
        guard: &Guard,
    ) -> Result<View, Error> {
        if let Some(accepted) = &saved.accepted {
            let current = status.address.is_none()
                && status.version == accepted.version
                && status.verification_version == accepted.head;
            let receipt_id = saved.input.operation_id;
            return Ok(View {
                status,
                state: if current { State::Removed { receipt_id } } else { State::RemovalStale { receipt_id } },
            });
        }
        guard.check()?;
        let receipt = match remote.resume_removal(saved.resume()).await {
            Ok(receipt) => {
                guard.check()?;
                receipt
            }
            Err(error) => {
                guard.check()?;
                if !missing(&error) {
                    return Err(error);
                }
                if status.address.is_none()
                    || status.version != saved.input.expected_version
                    || status.verification_version != saved.input.verification_version
                {
                    return Ok(View { status, state: State::RemovalStale { receipt_id: saved.input.operation_id } });
                }
                guard.check()?;
                match remote.remove(saved.input.clone()).await {
                    Ok(receipt) => {
                        guard.check()?;
                        receipt
                    }
                    Err(error) => {
                        guard.check()?;
                        let receipt_id = saved.input.operation_id;
                        if proof_needed(&error) {
                            return Ok(View { status, state: State::RemovalPending { receipt_id } });
                        }
                        if stale(&error) {
                            let status = self.live_email(&saved.scope, remote, guard).await?;
                            return Ok(View { status, state: State::RemovalStale { receipt_id } });
                        }
                        return Err(error);
                    }
                }
            }
        };
        self.received_email_removal(key, saved, receipt, remote, lease, guard).await
    }
    pub async fn email_remove(
        &self,
        scope: &Scope,
        remote: &dyn Remote,
        expected: &EmailStatus,
        guard: &Guard,
    ) -> Result<View, Error> {
        check_status(scope, expected)?;
        let key = scope.key()?;
        let lease = self.lease(&key, guard).await?;
        if self.read_email_intent(&key, scope, lease.clone(), guard).await?.is_some() {
            return Err(Error::Protocol("credentials_changed"));
        }
        let status = self.live_email(scope, remote, guard).await?;
        if status.address.is_none()
            || status.address != expected.address
            || status.version != expected.version
            || status.verification_version != expected.verification_version
        {
            return Err(Error::Protocol("credentials_changed"));
        }
        let saved = Record {
            kind: Kind::Removal,
            scope: scope.clone(),
            input: RemoveVerifiedEmail {
                operation_id: random_token()?,
                expected_version: status.version,
                verification_version: status.verification_version,
                context: scope.context(),
            },
            accepted: None,
        };
        self.write_email_removal(&key, &saved, lease.clone(), guard).await?;
        guard.check()?;
        let receipt = match remote.remove(saved.input.clone()).await {
            Ok(receipt) => {
                guard.check()?;
                receipt
            }
            Err(error) => {
                guard.check()?;
                if unconfirmed(&error) || stale(&error) {
                    let status = self.live_email(scope, remote, guard).await?;
                    let receipt_id = saved.input.operation_id;
                    return Ok(View {
                        status,
                        state: if stale(&error) {
                            State::RemovalStale { receipt_id }
                        } else {
                            State::RemovalPending { receipt_id }
                        },
                    });
                }
                return Err(error);
            }
        };
        self.received_email_removal(&key, saved, receipt, remote, lease, guard).await
    }
    pub(super) async fn cancel_email_removal(
        &self,
        key: &str,
        saved: Record,
        remote: &dyn Remote,
        lease: Arc<File>,
        guard: &Guard,
    ) -> Result<View, Error> {
        if saved.accepted.is_some() {
            let status = self.live_email(&saved.scope, remote, guard).await?;
            let view = self.recover_email_removal(key, saved, status, remote, lease.clone(), guard).await?;
            if matches!(view.state, State::Removed { .. }) {
                return Ok(view);
            }
            guard.check()?;
            self.storage.remove(format!("{key}-email"), lease).await?;
            guard.check()?;
            return Ok(View { status: view.status, state: State::Idle });
        }
        guard.check()?;
        let status = remote
            .retire_removal(RetireEmailRemoval {
                expected_version: saved.input.expected_version.clone(),
                verification_version: saved.input.verification_version.clone(),
                context: saved.scope.context(),
            })
            .await?;
        guard.check()?;
        check_status(&saved.scope, &status)?;
        if status.version == saved.input.expected_version
            && status.verification_version == saved.input.verification_version
        {
            return Err(invalid());
        }
        guard.check()?;
        match remote.resume_removal(saved.resume()).await {
            Ok(receipt) => {
                guard.check()?;
                return self.received_email_removal(key, saved, receipt, remote, lease, guard).await;
            }
            Err(error) => {
                guard.check()?;
                if !missing(&error) {
                    return Err(error);
                }
            }
        }
        // The old body is fenced before the original private slot is erased.
        guard.check()?;
        self.storage.remove(format!("{key}-email"), lease).await?;
        guard.check()?;
        Ok(View { status, state: State::Idle })
    }
}
