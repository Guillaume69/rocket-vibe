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
    let field = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    let info = SessionInfo {
        base_url: field("baseUrl"),
        user_id: field("userId"),
        username: field("username"),
        auth_token: field("authToken"),
    };
    (!info.base_url.is_empty() && !info.auth_token.is_empty() && !info.user_id.is_empty()).then_some(info)
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

/// Blocking.
pub fn save(dirs: &Dirs, info: &SessionInfo) -> Result<(), String> {
    let secret = json!({
        "baseUrl": info.base_url,
        "userId": info.user_id,
        "username": info.username,
        "authToken": info.auth_token,
    })
    .to_string();
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

pub fn set_active(dirs: &Dirs, info: &SessionInfo) {
    let _ = std::fs::write(dirs.file("active-account"), key(info));
}

/// Blocking.
pub fn remove(dirs: &Dirs, info: &SessionInfo) {
    let k = key(info);
    if let Ok(e) = entry(&k) {
        let _ = e.delete_credential();
    }
    let index = dirs.file("accounts");
    let mut all = lines(&index);
    all.retain(|l| *l != k);
    let _ = std::fs::write(index, all.join("\n"));
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
