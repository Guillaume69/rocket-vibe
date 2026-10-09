//! Sessions live in the system keychain, never on disk: the Secret Service
//! (KWallet, GNOME Keyring) on Linux, the Credential Manager on Windows, the
//! Keychain on macOS. One item per account, and a small file naming the active one.

use std::time::Duration;

use gtk::glib;
use rv_core::session::SessionInfo;
use serde_json::{Value, json};

/// A keyring that never answers (no D-Bus session, a prompt left open) must
/// not leave the app on its splash screen forever.
const TIMEOUT: Duration = Duration::from_secs(5);

/// Where the keychain keeps our items: the app's first id, kept when the id
/// changed so that signed-in sessions survive it.
const KEYCHAIN_SERVICE: &str = "me.barrut.RocketVibe";

pub fn account_key(info: &SessionInfo) -> String {
    format!("{}|{}", info.base_url, info.user_id)
}

fn active_file() -> std::path::PathBuf {
    glib::user_config_dir().join("rocket-vibe-rs").join("active-account")
}

pub fn active() -> Option<String> {
    std::fs::read_to_string(active_file()).ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
}

pub fn set_active(info: &SessionInfo) {
    let file = active_file();
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(file, account_key(info));
}

fn parse(secret: &[u8]) -> Option<SessionInfo> {
    let v: Value = serde_json::from_slice(secret).ok()?;
    SessionInfo::from_secret(&v)
}

/// Every account signed in on this machine, the active one first.
pub async fn load_all() -> Vec<SessionInfo> {
    let mut found: Vec<SessionInfo> = Vec::new();
    match tokio::time::timeout(TIMEOUT, keychain::all()).await {
        Ok(secrets) => {
            for info in secrets.iter().filter_map(|s| parse(s)) {
                if !found.iter().any(|f| account_key(f) == account_key(&info)) {
                    found.push(info);
                }
            }
        }
        Err(_) => eprintln!("Keychain did not answer, starting signed out."),
    }
    if let Some(active) = active() {
        found.sort_by_key(|info| account_key(info) != active);
    }
    found
}

pub async fn save(info: &SessionInfo) {
    save_with(info, None).await;
}

/// The account's E2E private key (a JWK) rides in its item, beside the
/// session, or leaves it when `None`: an unlock survives the next launch, as
/// in the web client, and locking or signing out forgets it.
pub async fn save_e2e(info: &SessionInfo, jwk: Option<&str>) {
    save_with(info, jwk).await;
}

/// The E2E private key kept for this account, if any.
pub async fn e2e_key(info: &SessionInfo) -> Option<String> {
    let secrets = tokio::time::timeout(TIMEOUT, keychain::all()).await.ok()?;
    secrets.iter().find_map(|s| {
        let v: Value = serde_json::from_slice(s).ok()?;
        let mine = v.get("baseUrl").and_then(Value::as_str) == Some(info.base_url.as_str())
            && v.get("userId").and_then(Value::as_str) == Some(info.user_id.as_str());
        mine.then(|| v.get("e2eKey").and_then(Value::as_str).map(str::to_owned)).flatten()
    })
}

async fn save_with(info: &SessionInfo, jwk: Option<&str>) {
    let lease = if info.native.is_some() {
        match rv_core::native::credentials::lease(&glib::user_config_dir().join("rocket-vibe-rs"), info).await {
            Ok(lease) => Some(std::sync::Arc::new(lease)),
            Err(_) => {
                eprintln!("Keychain write failed: credentials lock unavailable");
                return;
            }
        }
    } else {
        None
    };
    let mut secret = info.secret();
    if let Some(jwk) = jwk {
        secret["e2eKey"] = json!(jwk);
    }
    let secret = secret.to_string();
    if put_locked(account_key(info), secret.into_bytes(), lease).await.is_err() {
        eprintln!("Keychain write failed: secure storage unavailable");
    }
}

/// A timed-out or cancelled caller must not release the account lease while a
/// D-Bus mutation can still finish. The task keeps it until the actual answer.
async fn put_locked(
    key: String,
    secret: Vec<u8>,
    lease: Option<std::sync::Arc<std::fs::File>>,
) -> Result<(), rv_core::native::Error> {
    use rv_core::native::Error;
    let mut task = tokio::spawn(async move {
        let _lease = lease;
        keychain::put(&key, secret).await.map_err(|_| Error::Protocol("secure_storage_unavailable"))
    });
    tokio::time::timeout(TIMEOUT, &mut task)
        .await
        .map_err(|_| Error::Protocol("secure_storage_unavailable"))?
        .map_err(|_| Error::Protocol("secure_storage_unavailable"))?
}

pub async fn remove(info: &SessionInfo) {
    let lease = if info.native.is_some() {
        let Ok(lease) =
            rv_core::native::credentials::lease(&glib::user_config_dir().join("rocket-vibe-rs"), info).await
        else {
            return;
        };
        Some(lease)
    } else {
        None
    };
    let key = account_key(info);
    let mut task = tokio::spawn(async move {
        let _lease = lease;
        keychain::delete(&key).await;
    });
    let _ = tokio::time::timeout(TIMEOUT, &mut task).await;
}

struct NativeCredentials {
    config: std::path::PathBuf,
}
pub fn native_credentials() -> std::sync::Arc<dyn rv_core::native::credentials::Provider> {
    std::sync::Arc::new(NativeCredentials { config: glib::user_config_dir().join("rocket-vibe-rs") })
}

struct AuthenticationStorage;
pub fn authentication_vault() -> rv_core::native::authentication_vault::Vault {
    rv_core::native::authentication_vault::Vault::new(
        glib::user_config_dir().join("rocket-vibe-rs"),
        std::sync::Arc::new(AuthenticationStorage),
    )
}
pub fn security_vault() -> rv_core::native::security::Vault {
    rv_core::native::security::Vault::new(
        glib::user_config_dir().join("rocket-vibe-rs"),
        std::sync::Arc::new(AuthenticationStorage),
    )
}
pub fn email_recovery_vault() -> rv_core::native::email_recovery::Vault {
    rv_core::native::email_recovery::Vault::new(
        glib::user_config_dir().join("rocket-vibe-rs"),
        std::sync::Arc::new(AuthenticationStorage),
    )
}
async fn authentication_operation<T: Send + 'static>(
    lease: std::sync::Arc<std::fs::File>,
    operation: impl std::future::Future<Output = Result<T, String>> + Send + 'static,
) -> Result<T, rv_core::native::Error> {
    use rv_core::native::Error;
    // Dropping the outer future or timing out detaches this task. It retains the
    // lease through the ACTUAL DBus / blocking keyring completion.
    let mut task = tokio::spawn(async move {
        let _lease = lease;
        operation.await.map_err(|_| Error::Protocol("secure_storage_unavailable"))
    });
    tokio::time::timeout(TIMEOUT, &mut task)
        .await
        .map_err(|_| Error::Protocol("secure_storage_unavailable"))?
        .map_err(|_| Error::Protocol("secure_storage_unavailable"))?
}
impl rv_core::native::authentication_vault::Storage for AuthenticationStorage {
    fn read(
        &self,
        key: String,
        lease: std::sync::Arc<std::fs::File>,
    ) -> rv_core::native::authentication_vault::StorageFuture<Option<String>> {
        Box::pin(authentication_operation(lease, async move { keychain::private_get(&key, "authentication").await }))
    }
    fn write(
        &self,
        key: String,
        value: String,
        lease: std::sync::Arc<std::fs::File>,
    ) -> rv_core::native::authentication_vault::StorageFuture<()> {
        Box::pin(authentication_operation(lease, async move { keychain::private_put(&key, value).await }))
    }
    fn remove(
        &self,
        key: String,
        lease: std::sync::Arc<std::fs::File>,
    ) -> rv_core::native::authentication_vault::StorageFuture<()> {
        Box::pin(authentication_operation(lease, async move { keychain::private_remove(&key).await }))
    }
}
/// Full native login is not installed until this fallible credential write
/// succeeds. Preserve the account's E2EE key and persist the real expiry.
pub async fn save_native_login(record: &rv_core::native::credentials::Record) -> Result<(), rv_core::native::Error> {
    use rv_core::native::{Error, credentials};
    let lease =
        std::sync::Arc::new(credentials::lease(&glib::user_config_dir().join("rocket-vibe-rs"), &record.info).await?);
    let key = account_key(&record.info);
    let old =
        authentication_operation(lease.clone(), async move { keychain::private_get(&key, "session").await }).await?;
    let mut value = record.secret();
    if let Some(old) = old {
        let old: Value = serde_json::from_str(&old).map_err(|_| Error::Protocol("invalid_native_credentials"))?;
        let previous = SessionInfo::from_secret(&old).ok_or(Error::Protocol("invalid_native_credentials"))?;
        if account_key(&previous) != account_key(&record.info) {
            return Err(Error::Protocol("credentials_changed"));
        }
        if previous.native == record.info.native
            && let Some(jwk) = old.get("e2eKey")
        {
            value["e2eKey"] = jwk.clone();
        }
    }
    put_locked(account_key(&record.info), value.to_string().into_bytes(), Some(lease)).await
}
pub async fn complete_native_login(saved: &rv_core::native::authentication::LoginChallenge) {
    // Read the actually saved account; renewal may have advanced its bearer.
    let info = SessionInfo {
        mattermost: None,
        base_url: saved.base_url.clone(),
        user_id: saved.user.id.clone(),
        username: saved.user.username.clone(),
        auth_token: String::new(),
        native: Some(saved.identity.clone()),
    };
    if let Ok(raw) = raw_native(&info).await
        && let Some(actual) = SessionInfo::from_secret(&raw)
    {
        let _ = authentication_vault().clear_completed(saved, Some(&actual)).await;
    }
}
async fn raw_native(info: &SessionInfo) -> Result<Value, rv_core::native::Error> {
    use rv_core::native::Error;
    let secrets = tokio::time::timeout(TIMEOUT, keychain::all())
        .await
        .map_err(|_| Error::Protocol("secure_storage_unavailable"))?;
    secrets
        .into_iter()
        .filter_map(|raw| serde_json::from_slice::<Value>(&raw).ok())
        .find(|v| SessionInfo::from_secret(v).is_some_and(|s| account_key(&s) == account_key(info)))
        .ok_or(Error::Protocol("secure_storage_unavailable"))
}
impl rv_core::native::credentials::Provider for NativeCredentials {
    fn resume(&self, expected: SessionInfo) -> rv_core::native::credentials::CredentialFuture {
        let config = self.config.clone();
        Box::pin(async move {
            use rv_core::native::{Error, credentials};
            let lease = std::sync::Arc::new(credentials::lease(&config, &expected).await?);
            let raw = raw_native(&expected).await?;
            let record = credentials::Record::from_secret(&raw).ok_or(Error::Protocol("invalid_native_credentials"))?;
            if record.info.base_url != expected.base_url
                || record.info.user_id != expected.user_id
                || record.info.native != expected.native
            {
                return Err(Error::Protocol("server_identity_changed"));
            }
            let prior = std::sync::Arc::new(std::sync::Mutex::new(record.info.auth_token.clone()));
            let record = credentials::prepare(record, move |record| {
                let (prior, lease) = (prior.clone(), lease.clone());
                async move {
                    let old = raw_native(&record.info).await?;
                    let previous =
                        SessionInfo::from_secret(&old).ok_or(Error::Protocol("invalid_native_credentials"))?;
                    if previous.auth_token != *prior.lock().unwrap() || previous.native != record.info.native {
                        return Err(Error::Protocol("credentials_changed"));
                    }
                    let mut value = record.secret();
                    if let Some(key) = old.get("e2eKey") {
                        value["e2eKey"] = key.clone();
                    }
                    put_locked(account_key(&record.info), value.to_string().into_bytes(), Some(lease)).await?;
                    *prior.lock().unwrap() = record.info.auth_token;
                    Ok(())
                }
            })
            .await?;
            Ok(record.info)
        })
    }
}

#[cfg(target_os = "linux")]
mod keychain {
    use std::collections::HashMap;

    fn attributes() -> HashMap<&'static str, &'static str> {
        HashMap::from([("application", super::KEYCHAIN_SERVICE), ("kind", "session")])
    }

    pub async fn all() -> Vec<Vec<u8>> {
        let Ok(keyring) = oo7::Keyring::new().await else { return Vec::new() };
        let Ok(items) = keyring.search_items(&attributes()).await else { return Vec::new() };
        let mut secrets = Vec::new();
        for item in items {
            if let Ok(secret) = item.secret().await {
                secrets.push(secret.to_vec());
            }
        }
        secrets
    }

    pub async fn put(key: &str, secret: Vec<u8>) -> Result<(), String> {
        let keyring = oo7::Keyring::new().await.map_err(|e| e.to_string())?;
        // Items from before accounts had a key of their own: replaced by keyed ones.
        for item in keyring.search_items(&attributes()).await.map_err(|e| e.to_string())? {
            if item.attributes().await.is_ok_and(|a| !a.contains_key("account")) {
                let _ = item.delete().await;
            }
        }
        let mut attributes = attributes();
        attributes.insert("account", key);
        keyring.create_item("rocket-vibe session", &attributes, &secret, true).await.map_err(|e| e.to_string())
    }

    pub async fn delete(key: &str) {
        let Ok(keyring) = oo7::Keyring::new().await else { return };
        let mut attributes = attributes();
        attributes.insert("account", key);
        let _ = keyring.delete(&attributes).await;
    }
    pub async fn private_get(key: &str, kind: &'static str) -> Result<Option<String>, String> {
        let keyring = oo7::Keyring::new().await.map_err(|_| "secure_storage_unavailable".to_owned())?;
        let attributes = HashMap::from([("application", super::KEYCHAIN_SERVICE), ("kind", kind), ("account", key)]);
        let mut items = keyring.search_items(&attributes).await.map_err(|_| "secure_storage_unavailable".to_owned())?;
        if items.len() > 1 {
            return Err("invalid_native_authentication".into());
        }
        let Some(item) = items.pop() else { return Ok(None) };
        let secret = item.secret().await.map_err(|_| "secure_storage_unavailable".to_owned())?;
        String::from_utf8(secret.to_vec()).map(Some).map_err(|_| "invalid_native_authentication".into())
    }
    pub async fn private_put(key: &str, value: String) -> Result<(), String> {
        let keyring = oo7::Keyring::new().await.map_err(|_| "secure_storage_unavailable".to_owned())?;
        let attributes =
            HashMap::from([("application", super::KEYCHAIN_SERVICE), ("kind", "authentication"), ("account", key)]);
        keyring
            .create_item("rocket-vibe authentication", &attributes, value.as_bytes(), true)
            .await
            .map_err(|_| "secure_storage_unavailable".into())
    }
    pub async fn private_remove(key: &str) -> Result<(), String> {
        let keyring = oo7::Keyring::new().await.map_err(|_| "secure_storage_unavailable".to_owned())?;
        let attributes =
            HashMap::from([("application", super::KEYCHAIN_SERVICE), ("kind", "authentication"), ("account", key)]);
        keyring.delete(&attributes).await.map_err(|_| "secure_storage_unavailable".into())
    }
}

/// The system keychain cannot list its entries: a file keeps their keys
/// (server and user id, nothing secret).
#[cfg(not(target_os = "linux"))]
mod keychain {
    fn index_file() -> std::path::PathBuf {
        gtk::glib::user_config_dir().join("rocket-vibe-rs").join("accounts")
    }

    fn keys() -> Vec<String> {
        std::fs::read_to_string(index_file())
            .map(|s| s.lines().filter(|l| !l.is_empty()).map(str::to_owned).collect())
            .unwrap_or_default()
    }

    fn write_keys(keys: &[String]) {
        let file = index_file();
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, keys.join("\n"));
    }

    fn entry(key: &str) -> keyring::Result<keyring::Entry> {
        keyring::Entry::new(super::KEYCHAIN_SERVICE, key)
    }

    pub async fn all() -> Vec<Vec<u8>> {
        tokio::task::spawn_blocking(|| {
            keys().iter().filter_map(|k| entry(k).ok()?.get_password().ok()).map(String::into_bytes).collect()
        })
        .await
        .unwrap_or_default()
    }

    pub async fn put(key: &str, secret: Vec<u8>) -> Result<(), String> {
        let key = key.to_owned();
        tokio::task::spawn_blocking(move || {
            let secret = String::from_utf8(secret).map_err(|e| e.to_string())?;
            entry(&key).and_then(|e| e.set_password(&secret)).map_err(|e| e.to_string())?;
            let mut all = keys();
            if !all.contains(&key) {
                all.push(key);
                write_keys(&all);
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn delete(key: &str) {
        let key = key.to_owned();
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(e) = entry(&key) {
                let _ = e.delete_credential();
            }
            let mut all = keys();
            all.retain(|k| *k != key);
            write_keys(&all);
        })
        .await;
    }
    pub async fn private_get(key: &str, _kind: &'static str) -> Result<Option<String>, String> {
        let key = key.to_owned();
        tokio::task::spawn_blocking(move || {
            match entry(&key).map_err(|_| "secure_storage_unavailable".to_owned())?.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err("secure_storage_unavailable".into()),
            }
        })
        .await
        .map_err(|_| "secure_storage_unavailable".to_owned())?
    }
    pub async fn private_put(key: &str, value: String) -> Result<(), String> {
        let key = key.to_owned();
        tokio::task::spawn_blocking(move || {
            entry(&key).and_then(|e| e.set_password(&value)).map_err(|_| "secure_storage_unavailable".into())
        })
        .await
        .map_err(|_| "secure_storage_unavailable".to_owned())?
    }
    pub async fn private_remove(key: &str) -> Result<(), String> {
        let key = key.to_owned();
        tokio::task::spawn_blocking(move || {
            match entry(&key).map_err(|_| "secure_storage_unavailable".to_owned())?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err("secure_storage_unavailable".into()),
            }
        })
        .await
        .map_err(|_| "secure_storage_unavailable".to_owned())?
    }
}

fn servers_file() -> std::path::PathBuf {
    glib::user_config_dir().join("rocket-vibe-rs").join("servers")
}

/// Servers signed in to before, most recent first.
pub fn known_servers() -> Vec<String> {
    std::fs::read_to_string(servers_file())
        .map(|s| s.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect())
        .unwrap_or_default()
}

pub fn remember_server(base_url: &str) {
    let mut servers = known_servers();
    servers.retain(|s| s != base_url);
    servers.insert(0, base_url.to_owned());
    servers.truncate(8);
    let file = servers_file();
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(file, servers.join("\n"));
}
