//! Durable selection of a private vault for one authenticated HTTP device.
//! Reading a missing selection never creates an identity or replaces a vault.
use crate::{
    protected::{self, Manager, Storage},
    vault::{Error, Scope},
};
use data_encoding::HEXLOWER;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc};
use zeroize::Zeroizing;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Account {
    pub origin: String,
    pub instance: String,
    pub data_epoch: String,
    pub user: String,
    pub device: String,
}
impl Account {
    fn scope(&self, incarnation: String) -> Scope {
        Scope {
            instance: self.instance.clone(),
            data_epoch: self.data_epoch.clone(),
            user: self.user.clone(),
            device: self.device.clone(),
            incarnation,
        }
    }
}
#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    version: u8,
    scope: Scope,
    location: [u8; 32],
}
pub struct Installation {
    directory: PathBuf,
    account: Account,
    name: String,
    storage: Arc<dyn Storage>,
}
impl Installation {
    pub fn account(&self) -> &Account {
        &self.account
    }
    pub fn new(
        directory: PathBuf,
        account: Account,
        storage: Arc<dyn Storage>,
    ) -> Result<Self, Error> {
        if !protected::private_directory(&directory)
            || !account.scope("selected".into()).valid()
            || account.origin.is_empty()
            || account.origin.len() > 2048
            || account.origin.chars().any(char::is_control)
        {
            return Err(Error::Scope);
        }
        let tuple = serde_json::to_vec(&("rocketvibe-crypto-installation-v1", &account))
            .map_err(|_| Error::Scope)?;
        Ok(Self {
            directory,
            account,
            name: format!(
                "native-crypto-installation-{}",
                HEXLOWER.encode(&Sha256::digest(tuple))
            ),
            storage,
        })
    }
    fn location(&self) -> Result<[u8; 32], Error> {
        let path = protected::location(&self.directory)?;
        let mut hash = Sha256::new();
        hash.update(b"rocketvibe-crypto-installation-location-v1");
        hash.update(path.as_os_str().as_encoded_bytes());
        Ok(hash.finalize().into())
    }
    fn read(&self) -> Result<Option<Selection>, Error> {
        let Some(bytes) = self.storage.read(&self.name)? else {
            return Ok(None);
        };
        if bytes.len() > 4096 {
            return Err(Error::Limit);
        }
        let value: Selection = serde_json::from_slice(&bytes).map_err(|_| Error::Integrity)?;
        let nonce = HEXLOWER
            .decode(value.scope.incarnation.as_bytes())
            .map_err(|_| Error::Integrity)?;
        if value.version != 1
            || nonce.len() != 16
            || nonce.iter().all(|b| *b == 0)
            || HEXLOWER.encode(&nonce) != value.scope.incarnation
            || value.scope != self.account.scope(value.scope.incarnation.clone())
            || value.location != self.location()?
        {
            return Err(Error::Integrity);
        }
        Ok(Some(value))
    }
    fn manager(&self, value: Selection) -> Result<Arc<Manager>, Error> {
        Ok(Arc::new(Manager::new(
            self.directory.clone(),
            value.scope,
            self.storage.clone(),
        )?))
    }
    /// Positive absence is distinct from inaccessible or corrupt platform state.
    /// No key generation or vault initialization occurs here.
    pub fn load(&self) -> Result<Option<Arc<Manager>>, Error> {
        let _lease = protected::lease(&self.directory, &self.name)?;
        self.read()?.map(|value| self.manager(value)).transpose()
    }
    /// Explicit action only. Persist the incarnation before vault initialization,
    /// so interrupted initialization resumes this exact selection on next open.
    pub fn initialize(&self) -> Result<Arc<Manager>, Error> {
        let _lease = protected::lease(&self.directory, &self.name)?;
        let value = match self.read()? {
            Some(value) => value,
            None => {
                let mut nonce = [0; 16];
                getrandom::fill(&mut nonce).map_err(|_| Error::Storage)?;
                if nonce == [0; 16] {
                    return Err(Error::Storage);
                }
                let value = Selection {
                    version: 1,
                    scope: self.account.scope(HEXLOWER.encode(&nonce)),
                    location: self.location()?,
                };
                let bytes =
                    Zeroizing::new(serde_json::to_vec(&value).map_err(|_| Error::Integrity)?);
                self.storage.write(&self.name, &bytes)?;
                if self.read()?.as_ref() != Some(&value) {
                    return Err(Error::Stale);
                }
                value
            }
        };
        let manager = self.manager(value)?;
        manager.initialize()?;
        Ok(manager)
    }
}

#[cfg(test)]
mod tests;
