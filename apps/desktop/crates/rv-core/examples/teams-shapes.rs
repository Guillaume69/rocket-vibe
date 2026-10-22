//! Throwaway, READ-ONLY shape probe: prints the raw presence/profile/search/
//! conversation responses (own data only; search uses an unlikely term) between
//! markers. No message is sent, edited or deleted.
//!
//! Auth, two ways:
//!   cargo run -p rv-core --example teams-shapes
//!     device-code sign-in each run (interactive).
//!   TEAMS_PROBE_STORE=/path/to/token.json cargo run -p rv-core --example teams-shapes
//!     first run signs in and writes {tenant_id, refresh, user_id} to that path
//!     (0600); later runs read it and skip the sign-in. Microsoft rotates the
//!     refresh token on every use, so the file is rewritten as it rotates. The
//!     path is yours: keep it OUTSIDE the repo; it holds a live credential;
//!     delete it to revoke. Unset the variable and nothing is stored.
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use rv_core::session::SessionInfo;
use rv_core::teams::TeamsAccount;
use rv_core::teams::auth::{self, ORIGIN, Tokens};
use zeroize::Zeroizing;

fn store() -> Option<PathBuf> {
    std::env::var_os("TEAMS_PROBE_STORE").filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn load(path: &Path) -> Option<SessionInfo> {
    let value: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    let text = |key: &str| value[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    Some(session(text("tenant_id")?, Zeroizing::new(text("refresh")?), text("user_id")?))
}

fn session(tenant_id: String, refresh: Zeroizing<String>, user_id: String) -> SessionInfo {
    SessionInfo {
        base_url: ORIGIN.to_owned(),
        user_id,
        username: String::new(),
        auth_token: String::new(),
        native: None,
        mattermost: None,
        slack: None,
        teams: Some(TeamsAccount { tenant_id, refresh }),
    }
}

fn save(path: &Path, info: &SessionInfo) {
    let Some(account) = info.teams.as_ref() else { return };
    let body = serde_json::json!({
        "tenant_id": account.tenant_id,
        "refresh": account.refresh.as_str(),
        "user_id": info.user_id,
    });
    if fs::write(path, serde_json::to_vec_pretty(&body).unwrap_or_default()).is_ok() {
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
}

#[tokio::main]
async fn main() {
    // Rotation: persist the refreshed token back to the store as it rotates.
    if let Some(path) = store() {
        auth::set_credential_sink(move |info| save(&path, info));
    }
    let info = match store().and_then(|p| load(&p)) {
        Some(info) => info,
        None => {
            let code = auth::device_code().await.expect("device code");
            eprintln!("\n==> Open {} and enter code: {}\n", code.verification_uri, code.user_code);
            let info = auth::approved(&code, || false).await.expect("approved");
            if let Some(path) = store() {
                save(&path, &info);
            }
            info
        }
    };
    let me = info.user_id.clone();
    let tokens = Tokens::new(&info).expect("tokens");
    let shapes = tokens.probe_shapes(&me).await;
    println!("SHAPES_BEGIN");
    println!("{}", serde_json::to_string_pretty(&shapes).unwrap_or_default());
    println!("SHAPES_END");
}
