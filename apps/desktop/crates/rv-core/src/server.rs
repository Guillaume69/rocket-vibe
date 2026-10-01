//! What a server says about itself before anyone signs in.

use serde_json::Value;
use url::Url;

use crate::rest::{CallOptions, RestClient, RestError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerProfile {
    pub genre: String,
    pub base_url: String,
    /// Minor version only when anonymous (`8.5`).
    pub version: String,
    pub password_login: bool,
    pub two_factor: bool,
    pub e2e: bool,
    /// Providers configured, not supported here: shown so their absence is explained.
    pub oauth: Vec<String>,
    pub account_invitations: bool,
    pub account_recovery: bool,
}

pub fn profile_from(base_url: &str, info: &Value, settings: &Value) -> Option<ServerProfile> {
    let version = info.get("version")?.as_str()?.to_owned();
    let list = settings.get("settings")?.as_array()?;
    let get =
        |id: &str| list.iter().find(|s| s.get("_id").and_then(Value::as_str) == Some(id)).and_then(|s| s.get("value"));
    let on = |id: &str| get(id).and_then(Value::as_bool).unwrap_or(false);
    let mut oauth: Vec<String> = list
        .iter()
        .filter(|s| s.get("value") == Some(&Value::Bool(true)))
        .filter_map(|s| s.get("_id")?.as_str()?.strip_prefix("Accounts_OAuth_").map(str::to_owned))
        .filter(|name| !name.contains('_'))
        .collect();
    oauth.sort();
    Some(ServerProfile {
        genre: "rocketchat".into(),
        base_url: base_url.to_owned(),
        version,
        password_login: get("Accounts_ShowFormLogin").and_then(Value::as_bool).unwrap_or(true),
        two_factor: on("Accounts_TwoFactorAuthentication_Enabled"),
        e2e: on("E2E_Enable"),
        oauth,
        account_invitations: false,
        account_recovery: false,
    })
}

/// `/api/info` for the version (proof it is a Rocket.Chat), `settings.public`
/// (every page: `count=0`, `query` is ignored since 7.0) for the rest.
pub async fn probe(base: &Url) -> Result<ServerProfile, RestError> {
    if let Some(native) = crate::native::probe(base).await.map_err(crate::native::rest_error)? {
        return Ok(ServerProfile {
            genre: "rocketvibe".into(),
            base_url: base.as_str().trim_end_matches('/').into(),
            version: native.server_version,
            password_login: true,
            two_factor: false,
            e2e: native.capabilities.e2ee,
            oauth: vec![],
            account_invitations: native.capabilities.account_invitations,
            account_recovery: native.capabilities.account_recovery,
        });
    }
    let rest = RestClient::new(base.clone());
    let info = CallOptions { anonymous: true, outside_api_v1: true, ..Default::default() };
    let settings = CallOptions { anonymous: true, ..CallOptions::params([("count", "0")]) };
    let (info, settings) = tokio::join!(rest.get("api/info", info), rest.get("settings.public", settings));
    let base_url = base.as_str().trim_end_matches('/').to_owned();
    profile_from(&base_url, &info?, &settings?).ok_or_else(|| RestError::incomplete("not a Rocket.Chat server"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn profile() {
        let p = profile_from(
            "https://chat.example.org",
            &json!({"version":"8.5","success":true}),
            &json!({"settings":[
                {"_id":"Accounts_TwoFactorAuthentication_Enabled","value":true},
                {"_id":"E2E_Enable","value":true},
                {"_id":"Accounts_OAuth_Google","value":true},
                {"_id":"Accounts_OAuth_Google_id","value":"x"},
                {"_id":"Accounts_OAuth_Facebook","value":false}
            ]}),
        )
        .unwrap();
        assert_eq!(p.version, "8.5");
        assert!(p.password_login && p.two_factor && p.e2e);
        assert_eq!(p.oauth, ["Google"]);
        assert!(profile_from("x", &json!({"message":"hi"}), &json!({"settings":[]})).is_none());
    }
}
