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
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
    }
}

#[tokio::main]
async fn main() {
    // Re-auth mode: request the broader Graph scopes (Chat.ReadWrite,
    // ChannelSettings.ReadWrite.All) to check whether the tenant consents to
    // them, WITHOUT touching the stored working token (ephemeral, no sink, no
    // save). The probe's graph_features then shows the pins/room-settings
    // statuses with the broader token.
    if std::env::var_os("TEAMS_PROBE_REAUTH").is_some_and(|v| !v.is_empty()) {
        let scope = "offline_access openid profile \
            https://graph.microsoft.com/Chat.ReadWrite \
            https://graph.microsoft.com/ChannelSettings.ReadWrite.All \
            https://graph.microsoft.com/Files.ReadWrite.All";
        let code = auth::device_code_scope(scope).await.expect("device code");
        eprintln!("\n==> REAUTH (broader scopes): open {} and enter code: {}\n", code.verification_uri, code.user_code);
        let info = auth::approved(&code, || false).await.expect("approved");
        let me = info.user_id.clone();
        let tokens = Tokens::new(&info).expect("tokens");
        let shapes = tokens.probe_shapes(&me).await;
        println!("SHAPES_BEGIN");
        println!("{}", serde_json::to_string_pretty(&shapes).unwrap_or_default());
        println!("SHAPES_END");
        return;
    }
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
    // Pin round-trip probe: a user-authorized live write that pins then unpins
    // one known channel post to learn the CSA read shape. Ids default to the
    // capture's test channel; override with TEAMS_PIN_TEAM/CHANNEL/POST.
    if std::env::var_os("TEAMS_PROBE_PIN").is_some_and(|v| !v.is_empty()) {
        let env = |key: &str, default: &str| std::env::var(key).unwrap_or_else(|_| default.to_owned());
        let team = env("TEAMS_PIN_TEAM", "19:30c22b53ecfc46eeb99d89d5c4429edd@thread.tacv2");
        let channel = env("TEAMS_PIN_CHANNEL", "19:VWiAIWKIbdNqlBPzHGegbdN09-VGacp1PMQCEeL96ZE1@thread.tacv2");
        let post = env("TEAMS_PIN_POST", "1792713056746");
        let shapes = tokens.probe_pin(&team, &channel, &post).await;
        println!("SHAPES_BEGIN");
        println!("{}", serde_json::to_string_pretty(&shapes).unwrap_or_default());
        println!("SHAPES_END");
        return;
    }
    // Channel-settings probe: a user-authorized, self-restoring write on the
    // test channel (no-op rename, then a description change undone).
    if std::env::var_os("TEAMS_PROBE_RENAME").is_some_and(|v| !v.is_empty()) {
        let channel = std::env::var("TEAMS_PIN_CHANNEL")
            .unwrap_or_else(|_| "19:VWiAIWKIbdNqlBPzHGegbdN09-VGacp1PMQCEeL96ZE1@thread.tacv2".to_owned());
        let shapes = tokens.probe_rename(&channel).await;
        println!("SHAPES_BEGIN");
        println!("{}", serde_json::to_string_pretty(&shapes).unwrap_or_default());
        println!("SHAPES_END");
        return;
    }
    // Read-only id hunt: every field of the reads below whose value contains
    // TEAMS_PROBE_FIND, with its JSON path.
    if let Some(needle) = std::env::var_os("TEAMS_PROBE_FIND").and_then(|v| v.into_string().ok()) {
        let team = std::env::var("TEAMS_PIN_TEAM")
            .unwrap_or_else(|_| "19:30c22b53ecfc46eeb99d89d5c4429edd@thread.tacv2".to_owned());
        let channel = std::env::var("TEAMS_PIN_CHANNEL")
            .unwrap_or_else(|_| "19:VWiAIWKIbdNqlBPzHGegbdN09-VGacp1PMQCEeL96ZE1@thread.tacv2".to_owned());
        let group =
            std::env::var("TEAMS_PIN_GROUP").unwrap_or_else(|_| "c08557f5-e913-4f5b-ab1b-3e9a2f7102bd".to_owned());
        let shapes = tokens.probe_find(&needle, &team, &channel, &group).await;
        println!("SHAPES_BEGIN");
        println!("{}", serde_json::to_string_pretty(&shapes).unwrap_or_default());
        println!("SHAPES_END");
        return;
    }
    // File-upload round-trip probe: a user-authorized live write that uploads a
    // tiny file to the channel's files folder, posts it, reads it back, then
    // deletes both. Channel defaults to the capture's; override TEAMS_PIN_CHANNEL.
    if std::env::var_os("TEAMS_PROBE_UPLOAD").is_some_and(|v| !v.is_empty()) {
        let channel = std::env::var("TEAMS_PIN_CHANNEL")
            .unwrap_or_else(|_| "19:VWiAIWKIbdNqlBPzHGegbdN09-VGacp1PMQCEeL96ZE1@thread.tacv2".to_owned());
        let shapes = tokens.probe_upload(&channel).await;
        println!("SHAPES_BEGIN");
        println!("{}", serde_json::to_string_pretty(&shapes).unwrap_or_default());
        println!("SHAPES_END");
        return;
    }
    let shapes = tokens.probe_shapes(&me).await;
    println!("SHAPES_BEGIN");
    println!("{}", serde_json::to_string_pretty(&shapes).unwrap_or_default());
    println!("SHAPES_END");
}
