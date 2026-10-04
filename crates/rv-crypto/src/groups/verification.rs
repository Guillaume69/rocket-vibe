//! Historical authentication is a private receive policy. Sending and fresh
//! admissions continue to require current certificate validity.
use super::*;
use openmls::prelude::Credential;

#[derive(Clone, Copy)]
pub(super) enum Verification {
    Current(u64),
    Historical(u64),
}
impl Verification {
    pub fn at(now: u64, historical: bool) -> Self {
        if historical {
            Self::Historical(now)
        } else {
            Self::Current(now)
        }
    }
    pub fn certificate(self, certificate: &Certificate) -> Result<()> {
        match self {
            Self::Current(now) => certificate.verify(now)?,
            Self::Historical(now) => {
                certificate.authenticate()?;
                // Never accept a future-issued credential by faking the clock.
                if now < certificate.device.issued_at {
                    return Err(identity::Error::Expired.into());
                }
            }
        }
        Ok(())
    }
    pub fn transition(self, transition: &Transition) -> Result<()> {
        match self {
            Self::Current(now) => transition.verify(now)?,
            Self::Historical(_) => {
                self.certificate(&transition.certificate)?;
                transition.authenticate()?;
            }
        }
        Ok(())
    }
    pub fn peer(self, pins: &Pins, credential: &Credential, key: &[u8]) -> Result<()> {
        match self {
            Self::Current(now) => {
                pins.authorize_credential(credential, key, now)?;
            }
            Self::Historical(now) => {
                pins.authorize_history_credential(credential, key, now)?;
            }
        }
        Ok(())
    }
    pub fn own_matches(self, historical: &Certificate, current: &Certificate) -> bool {
        match self {
            Self::Current(_) => historical == current,
            Self::Historical(_) => {
                let a = &historical.device;
                let b = &current.device;
                a.root == b.root
                    && a.device == b.device
                    && a.incarnation == b.incarnation
                    && a.signature_key == b.signature_key
            }
        }
    }
}
