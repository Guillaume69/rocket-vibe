//! One durable delivery intent inside the original private factor challenge.
//! Only an explicit gesture starts/retries/resends mail; reads never do so.
use super::{
    Error, Identity, check, credentials,
    security::{Guard, RemoteFuture},
};
use rv_client::NativeClient;
use rv_protocol::parity::{AuthChallenge, FactorEmailDelivery, RequestFactorEmail, SecondFactor};
use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use std::future::Future;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Intent {
    pub input: RequestFactorEmail,
    #[serde(deserialize_with = "private_status")]
    pub status: Option<FactorEmailDelivery>,
}
pub(super) fn private_intent<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Intent>, D::Error> {
    Intent::deserialize(d).map(Some)
}
fn invalid() -> Error {
    Error::Protocol("invalid_native_security")
}
fn nonce(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
// The public DTO tolerates additive server fields. A private trousseau record
// accepts only display metadata, so an accidental code/password is not retained.
fn private_status<'de, D: Deserializer<'de>>(d: D) -> Result<Option<FactorEmailDelivery>, D::Error> {
    let Some(value) = Option::<serde_json::Value>::deserialize(d)? else { return Ok(None) };
    if !value.as_object().is_some_and(|m| {
        m.len() == 3 && m.keys().all(|k| matches!(k.as_str(), "expires_at" | "delivery" | "resend_after_seconds"))
    }) {
        return Err(D::Error::custom("invalid_native_security"));
    }
    serde_json::from_value(value).map(Some).map_err(|_| D::Error::custom("invalid_native_security"))
}
pub(super) fn same_deadline(a: &str, b: &str) -> bool {
    match (chrono::DateTime::parse_from_rfc3339(a), chrono::DateTime::parse_from_rfc3339(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}
fn status(challenge: &AuthChallenge, value: &FactorEmailDelivery) -> Result<(), Error> {
    if !same_deadline(&challenge.expires_at, &value.expires_at) || value.resend_after_seconds > 60 {
        return Err(invalid());
    }
    Ok(())
}
impl Intent {
    pub fn validate(&self, challenge: &AuthChallenge) -> Result<(), Error> {
        let input = &self.input;
        if !challenge.methods.iter().any(|m| matches!(m, SecondFactor::Email))
            || input.challenge_id != challenge.challenge_id
            || [&input.challenge_id, &input.delivery_id, &input.operation_id].iter().any(|id| !nonce(id))
            || input.delivery_id == input.operation_id
            || input.delivery_id == input.challenge_id
            || input.operation_id == input.challenge_id
        {
            return Err(invalid());
        }
        if let Some(value) = &self.status {
            status(challenge, value)?;
        }
        Ok(())
    }
    pub fn same_candidate(&self, other: &Self) -> bool {
        self.input.challenge_id == other.input.challenge_id
            && self.input.delivery_id == other.input.delivery_id
            && self.input.operation_id == other.input.operation_id
    }
}
pub trait Remote: Send + Sync {
    fn begin(&self, input: RequestFactorEmail) -> RemoteFuture<FactorEmailDelivery>;
    fn resume(&self, input: RequestFactorEmail) -> RemoteFuture<FactorEmailDelivery>;
}
pub(super) struct LoginRemote {
    pub client: NativeClient,
    pub identity: Identity,
    pub guard: Guard,
}
impl LoginRemote {
    async fn call(&self, input: RequestFactorEmail, start: bool) -> Result<FactorEmailDelivery, Error> {
        self.guard.check()?;
        let discovery = self.client.discover().await?;
        self.guard.check()?;
        check(&self.identity, &discovery)?;
        if start && !discovery.capabilities.email_factor_delivery {
            return Err(Error::Protocol("unsupported_feature"));
        }
        let value = if start {
            self.client.begin_factor_email(&input).await?
        } else {
            self.client.resume_factor_email(&input).await?
        };
        self.guard.check()?;
        check(&self.identity, &self.client.discover().await?)?;
        self.guard.check()?;
        Ok(value)
    }
}
impl Remote for LoginRemote {
    fn begin(&self, input: RequestFactorEmail) -> RemoteFuture<FactorEmailDelivery> {
        let remote = Self { client: self.client.clone(), identity: self.identity.clone(), guard: self.guard.clone() };
        Box::pin(async move { remote.call(input, true).await })
    }
    fn resume(&self, input: RequestFactorEmail) -> RemoteFuture<FactorEmailDelivery> {
        let remote = Self { client: self.client.clone(), identity: self.identity.clone(), guard: self.guard.clone() };
        Box::pin(async move { remote.call(input, false).await })
    }
}
/// Called under the parent vault's OS lease for one explicit UI action. A lost
/// acknowledgement retains the saved original candidate; it cannot resend.
pub async fn send<F, Fut>(
    challenge: &AuthChallenge,
    previous: Option<Intent>,
    resend: bool,
    remote: &dyn Remote,
    guard: &Guard,
    mut save: F,
) -> Result<Intent, Error>
where
    F: FnMut(Intent) -> Fut,
    Fut: Future<Output = Result<(), Error>>,
{
    guard.check()?;
    if !challenge.methods.iter().any(|m| matches!(m, SecondFactor::Email)) {
        return Err(Error::Protocol("factor_unavailable"));
    }
    let mut intent = previous;
    if let Some(saved) = &intent {
        saved.validate(challenge)?;
    }
    if resend && intent.as_ref().is_none_or(|i| i.status.is_none()) {
        return Err(Error::Protocol("credentials_changed"));
    }
    if let Some(saved) = &mut intent {
        let resumed = remote.resume(saved.input.clone()).await;
        guard.check()?;
        match resumed {
            Ok(value) => {
                status(challenge, &value)?;
                saved.status = Some(value);
                save(saved.clone()).await?;
                guard.check()?;
                if !resend {
                    return Ok(saved.clone());
                }
                let cooldown = saved.status.as_ref().unwrap().resend_after_seconds;
                if cooldown > 0 {
                    return Err(Error::Network(rv_client::Error::Server {
                        status: 429,
                        code: "email_resend_cooldown".into(),
                        request_id: None,
                        retry_after: Some(cooldown.into()),
                    }));
                }
            }
            Err(Error::Network(rv_client::Error::Server { status: 400, ref code, .. }))
                if !resend && code == "factor_rejected" => {}
            Err(error) => return Err(error),
        }
    }
    if intent.is_none() || resend {
        let fresh = Intent {
            input: RequestFactorEmail {
                challenge_id: challenge.challenge_id.clone(),
                delivery_id: credentials::token()?,
                operation_id: credentials::token()?,
            },
            status: None,
        };
        fresh.validate(challenge)?;
        save(fresh.clone()).await?;
        guard.check()?;
        intent = Some(fresh);
    }
    let mut saved = intent.unwrap();
    let value = remote.begin(saved.input.clone()).await;
    guard.check()?;
    let value = value?;
    status(challenge, &value)?;
    saved.status = Some(value);
    save(saved.clone()).await?;
    guard.check()?;
    Ok(saved)
}
