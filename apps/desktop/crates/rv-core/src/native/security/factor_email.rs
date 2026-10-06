//! OTP delivery retains the existing family's proof slot and OS lease.
use super::*;
use crate::native::factor_email::{self as delivery, Intent};
use std::sync::Mutex;

impl NativeSession {
    pub fn email_factor_delivery_supported(&self) -> bool {
        self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.email_factor_delivery)
    }
}
impl Access {
    pub(super) async fn factor_email_call(
        &self,
        input: RequestFactorEmail,
        start: bool,
    ) -> Result<FactorEmailDelivery, Error> {
        self.before(false).await?;
        if start && !self.session.email_factor_delivery_supported() {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let value = if start {
            self.session.client.begin_reauthentication_email(&input).await?
        } else {
            self.session.client.resume_reauthentication_email(&input).await?
        };
        self.check()?;
        Ok(value)
    }
}
struct Mail<'a>(&'a dyn Remote);
impl delivery::Remote for Mail<'_> {
    fn begin(&self, input: RequestFactorEmail) -> RemoteFuture<FactorEmailDelivery> {
        self.0.email_begin(input)
    }
    fn resume(&self, input: RequestFactorEmail) -> RemoteFuture<FactorEmailDelivery> {
        self.0.email_resume(input)
    }
}
impl Vault {
    pub async fn send_email(
        &self,
        expected: &ProofAttempt,
        remote: &dyn Remote,
        resend: bool,
        guard: &Guard,
    ) -> Result<ProofState, Error> {
        expected.validate(&expected.scope)?;
        let scope = &expected.scope;
        let key = scope.key()?;
        let lease = self.lease(&key, guard).await?;
        self.status(scope, remote, guard).await?;
        let saved =
            self.read_proof(&key, scope, lease.clone(), guard).await?.ok_or(Error::Protocol("credentials_changed"))?;
        if saved.challenge_id != expected.challenge_id
            || saved.operation_id != expected.operation_id
            || (resend && !matches!((&saved.email, &expected.email), (Some(a), Some(b)) if a.same_candidate(b)))
        {
            return Err(Error::Protocol("credentials_changed"));
        }
        let challenge = saved.challenge.as_ref().ok_or_else(invalid)?.clone();
        match self.probe(&saved, remote, guard).await? {
            Some(ReauthenticationStep::Granted { grant }) => {
                return self.accepted(&key, &saved, grant, remote, lease, guard).await;
            }
            Some(ReauthenticationStep::Challenge { challenge: live })
                if live.challenge_id == challenge.challenge_id
                    && delivery::same_deadline(&live.expires_at, &challenge.expires_at) => {}
            _ => return Err(Error::Protocol("reauthentication_rejected")),
        }
        let previous = saved.email.clone();
        let tracked = Arc::new(Mutex::new(saved));
        let tracked_for_write = tracked.clone();
        delivery::send(&challenge, previous, resend, &Mail(remote), guard, move |email: Intent| {
            let (lease, tracked) = (lease.clone(), tracked_for_write.clone());
            let prior = tracked.lock().unwrap().clone();
            let key = key.clone();
            async move {
                guard.check()?;
                let actual = self
                    .read_proof(&key, scope, lease.clone(), guard)
                    .await?
                    .ok_or(Error::Protocol("credentials_changed"))?;
                if serde_json::to_string(&actual).map_err(|_| invalid())?
                    != serde_json::to_string(&prior).map_err(|_| invalid())?
                {
                    return Err(Error::Protocol("credentials_changed"));
                }
                let mut updated = prior;
                updated.email = Some(email);
                self.write_proof(&key, &updated, lease, guard).await?;
                *tracked.lock().unwrap() = updated;
                Ok(())
            }
        })
        .await?;
        let saved = tracked.lock().unwrap().clone();
        Ok(ProofState::Challenge(Box::new(saved)))
    }
}
