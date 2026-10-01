//! Signed-in accounts, kept exactly where rv-gtk keeps them on macOS so both
//! apps share sessions: one Keychain item per account, a file listing them
//! (the Keychain cannot list its items), a file naming the active one.

use std::path::{Path, PathBuf};

use rv_core::session::SessionInfo;
use serde_json::{Value, json};

const KEYCHAIN_SERVICE: &str = "me.barrut.RocketVibe";

pub struct Dirs {
    pub config: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
}

impl Dirs {
    /// GLib's user directories, which have no macOS case: XDG, from the home.
    pub fn glib(home: &Path) -> Self {
        let xdg = |var: &str, fallback: &str| {
            std::env::var_os(var)
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .unwrap_or_else(|| home.join(fallback))
                .join("rocket-vibe-rs")
        };
        Dirs {
            config: xdg("XDG_CONFIG_HOME", ".config"),
            data: xdg("XDG_DATA_HOME", ".local/share"),
            cache: xdg("XDG_CACHE_HOME", ".cache"),
        }
    }

    fn file(&self, name: &str) -> PathBuf {
        let _ = std::fs::create_dir_all(&self.config);
        self.config.join(name)
    }

    pub fn database(&self, info: &SessionInfo) -> PathBuf {
        if info.native.is_some() {
            let _ = std::fs::create_dir_all(&self.data);
            return self.data.join(rv_core::native::database_name(info));
        }
        let url: url::Url = info.base_url.parse().expect("base URL");
        let host = match url.port() {
            Some(port) => format!("{}_{port}", url.host_str().unwrap_or_default()),
            None => url.host_str().unwrap_or_default().to_owned(),
        };
        let _ = std::fs::create_dir_all(&self.data);
        self.data.join(format!("{host}-{}.sqlite", info.user_id))
    }
}

pub fn key(info: &SessionInfo) -> String {
    format!("{}|{}", info.base_url, info.user_id)
}

fn lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .map(|s| s.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect())
        .unwrap_or_default()
}

fn entry(key: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, key)
}

fn parse(secret: &str) -> Option<SessionInfo> {
    let v: Value = serde_json::from_str(secret).ok()?;
    SessionInfo::from_secret(&v)
}

/// Every account signed in on this machine, the active one first. Blocking.
pub fn load_all(dirs: &Dirs) -> Vec<SessionInfo> {
    let mut found: Vec<SessionInfo> = Vec::new();
    for k in lines(&dirs.file("accounts")) {
        if let Some(info) = entry(&k).ok().and_then(|e| e.get_password().ok()).and_then(|s| parse(&s))
            && !found.iter().any(|f| key(f) == key(&info))
        {
            found.push(info);
        }
    }
    if let Some(active) = lines(&dirs.file("active-account")).into_iter().next() {
        found.sort_by_key(|info| key(info) != active);
    }
    found
}

/// Blocking. `e2e_key`: my E2E private key (a JWK) while unlocked, kept
/// beside the session as the GTK app keeps it.
pub fn save(dirs: &Dirs, info: &SessionInfo, e2e_key: Option<&str>) -> Result<(), String> {
    let _lease = if info.native.is_some() {
        Some(rv_core::native::credentials::lease_blocking(&dirs.config, info).map_err(|e| e.to_string())?)
    } else {
        None
    };
    let mut secret = info.secret();
    if let Some(jwk) = e2e_key {
        secret["e2eKey"] = json!(jwk);
    }
    let secret = secret.to_string();
    let k = key(info);
    entry(&k).and_then(|e| e.set_password(&secret)).map_err(|e| e.to_string())?;
    let index = dirs.file("accounts");
    let mut all = lines(&index);
    if !all.contains(&k) {
        all.push(k.clone());
        let _ = std::fs::write(index, all.join("\n"));
    }
    set_active(dirs, info);
    Ok(())
}

/// The E2E key kept for the account, if any. Blocking.
pub fn e2e_key(info: &SessionInfo) -> Option<String> {
    let secret = entry(&key(info)).ok()?.get_password().ok()?;
    let v: Value = serde_json::from_str(&secret).ok()?;
    v.get("e2eKey").and_then(Value::as_str).map(str::to_owned)
}

pub fn set_active(dirs: &Dirs, info: &SessionInfo) {
    let _ = std::fs::write(dirs.file("active-account"), key(info));
}

/// Blocking.
pub fn remove(dirs: &Dirs, info: &SessionInfo) {
    let _lease = if info.native.is_some() {
        let Ok(lease) = rv_core::native::credentials::lease_blocking(&dirs.config, info) else { return };
        Some(lease)
    } else {
        None
    };
    let k = key(info);
    if let Ok(e) = entry(&k) {
        let _ = e.delete_credential();
    }
    let index = dirs.file("accounts");
    let mut all = lines(&index);
    all.retain(|l| *l != k);
    let _ = std::fs::write(index, all.join("\n"));
}

/// Caller holds the shared file lease across the entire renewal transaction.
pub fn native_record(info: &SessionInfo) -> Result<rv_core::native::credentials::Record, String> {
    let secret =
        entry(&key(info)).and_then(|e| e.get_password()).map_err(|_| "secure_storage_unavailable".to_owned())?;
    let value: Value = serde_json::from_str(&secret).map_err(|_| "invalid_native_credentials".to_owned())?;
    rv_core::native::credentials::Record::from_secret(&value).ok_or_else(|| "invalid_native_credentials".to_owned())
}
pub fn replace_native_record(
    record: &rv_core::native::credentials::Record,
    expected_token: &str,
) -> Result<(), String> {
    let item = entry(&key(&record.info)).map_err(|_| "secure_storage_unavailable".to_owned())?;
    let raw = item.get_password().map_err(|_| "secure_storage_unavailable".to_owned())?;
    let old: Value = serde_json::from_str(&raw).map_err(|_| "invalid_native_credentials".to_owned())?;
    let previous = SessionInfo::from_secret(&old).ok_or_else(|| "invalid_native_credentials".to_owned())?;
    if previous.auth_token != expected_token
        || previous.native != record.info.native
        || key(&previous) != key(&record.info)
    {
        return Err("credentials_changed".into());
    }
    let mut secret = record.secret();
    if let Some(jwk) = old.get("e2eKey") {
        secret["e2eKey"] = jwk.clone();
    }
    item.set_password(&secret.to_string()).map_err(|_| "secure_storage_unavailable".to_owned())
}

/// Servers signed in to before, most recent first.
pub fn known_servers(dirs: &Dirs) -> Vec<String> {
    lines(&dirs.file("servers"))
}

pub fn remember_server(dirs: &Dirs, server: &str) {
    let mut all = known_servers(dirs);
    all.retain(|s| s != server);
    all.insert(0, server.to_owned());
    all.truncate(8);
    let _ = std::fs::write(dirs.file("servers"), all.join("\n"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn databases_are_named_by_host_port_and_user() {
        let dirs = Dirs {
            config: std::env::temp_dir().join("rv-ffi-test-config"),
            data: std::env::temp_dir().join("rv-ffi-test-data"),
            cache: std::env::temp_dir().join("rv-ffi-test-cache"),
        };
        let info = |base: &str| SessionInfo {
            base_url: base.into(),
            user_id: "U1".into(),
            username: "me".into(),
            auth_token: "t".into(),
            native: None,
        };
        assert_eq!(dirs.database(&info("https://chat.example.com")), dirs.data.join("chat.example.com-U1.sqlite"));
        assert_eq!(dirs.database(&info("http://localhost:3000")), dirs.data.join("localhost_3000-U1.sqlite"));
        assert_eq!(key(&info("https://chat.example.com")), "https://chat.example.com|U1");
    }

    #[test]
    fn servers_most_recent_first() {
        let config = std::env::temp_dir().join(format!("rv-ffi-servers-{}", std::process::id()));
        let dirs = Dirs { config: config.clone(), data: config.clone(), cache: config.clone() };
        for s in ["a", "b", "a", "c"] {
            remember_server(&dirs, s);
        }
        assert_eq!(known_servers(&dirs), ["c", "a", "b"]);
        let _ = std::fs::remove_dir_all(config);
    }
}
